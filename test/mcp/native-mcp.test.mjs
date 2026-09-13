import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import test from 'node:test';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import YAML from 'yaml';

import { createNativeMcp } from '../../dist/mcp/index.js';

const GOOD_TOKEN = 'test-good-token';

function fakeService() {
  const calls = [];
  return {
    calls,
    async meta({ name }) {
      return { cubes: [{ name: name || 'EmergencyEvents' }], summary: !name, generatedAt: Date.now() };
    },
    async load(input) {
      calls.push(input);
      if (input.query.fail === true) {
        const error = new Error('模拟 Cube 查询失败');
        error.code = 'cube_http_error';
        error.status = 400;
        throw error;
      }
      return {
        queryType: 'regularQuery',
        results: [{ annotation: {}, data: [{ 'EmergencyEvents.count': '2' }] }],
      };
    },
    async dryRun() {
      return { normalizedQueries: [] };
    },
    async search(input) {
      calls.push(input);
      return { results: [{ annotation: {}, data: [] }] };
    },
    glossaryResolve({ text }) {
      return { ok: true, hits: [{ alias: text, standard: '示例机构 A' }] };
    },
  };
}

async function startFixture({ instructions } = {}) {
  const service = fakeService();
  const audit = [];
  const nativeMcp = createNativeMcp({
    service,
    allowedHosts: ['127.0.0.1', 'localhost'],
    allowedOrigins: ['http://127.0.0.1'],
    instructions,
    verifyAccessToken(token) {
      if (token === 'wrong-scope') {
        return { token, clientId: 'scope-test', scopes: [], expiresAt: Math.floor(Date.now() / 1000) + 60 };
      }
      if (token !== GOOD_TOKEN) throw new Error('invalid token');
      return {
        token,
        clientId: 'native-mcp-test',
        scopes: ['cube:read'],
        expiresAt: Math.floor(Date.now() / 1000) + 60,
      };
    },
    audit: (event) => audit.push(event),
  });

  const httpServer = http.createServer((req, res) => nativeMcp.handle(req, res));
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  const address = httpServer.address();
  const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);

  return {
    service,
    audit,
    endpoint,
    nativeMcp,
    httpServer,
    async close() {
      await nativeMcp.close();
      await new Promise((resolve) => httpServer.close(resolve));
    },
  };
}

test('official MCP client discovers stable CubeBuddy tool schemas', async (t) => {
  const fixture = await startFixture({ instructions: '仅用于目录查询；禁止猜测物理表。' });
  t.after(() => fixture.close());

  const client = new Client({ name: 'cubebuddy-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(fixture.endpoint, {
    authProvider: { token: async () => GOOD_TOKEN },
  });
  await client.connect(transport);
  t.after(() => client.close());
  assert.equal(client.getInstructions(), '仅用于目录查询；禁止猜测物理表。');

  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ['cube_dry_run', 'cube_glossary_resolve', 'cube_load', 'cube_meta', 'cube_meta_detail', 'cube_search'],
  );

  const load = tools.find((tool) => tool.name === 'cube_load');
  assert.ok(load);
  assert.equal(load.inputSchema.type, 'object');
  assert.deepEqual(load.inputSchema.required, ['query']);
  assert.equal(load.inputSchema.properties.query.type, 'object');
  assert.ok(load.inputSchema.properties.query.properties.order.anyOf);
  assert.equal(load.outputSchema.type, 'object');
  assert.deepEqual(load.outputSchema.required, ['results']);
  assert.equal(load.outputSchema.properties.queryType.type, 'string');
  assert.deepEqual(load.outputSchema.properties.results.items.required, ['annotation', 'data']);
  assert.equal(load.outputSchema.properties.results.items.properties.external.type, 'boolean');
  assert.equal(load.outputSchema.properties.results.items.properties.lastRefreshTime.type, 'string');
});

test('OpenAPI operations and MCP tools retain their documented mapping', async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const client = new Client({ name: 'cubebuddy-contract-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(fixture.endpoint, {
    authProvider: { token: async () => GOOD_TOKEN },
  }));
  t.after(() => client.close());

  const openApi = YAML.parse(await readFile(new URL('../../server/openapi/openapi.yaml', import.meta.url), 'utf8'));
  const operations = Object.values(openApi.paths)
    .flatMap((pathItem) => Object.entries(pathItem)
      .filter(([method]) => ['get', 'post'].includes(method))
      .map(([, operation]) => operation.operationId));
  assert.deepEqual(operations.sort(), [
    'cube_glossary_resolve', 'cube_load', 'cube_meta', 'cube_meta_detail', 'cube_search',
  ]);

  const { tools } = await client.listTools();
  const toolNames = tools.map((tool) => tool.name).sort();
  assert.deepEqual(toolNames, [...operations, 'cube_dry_run'].sort());

  const load = tools.find((tool) => tool.name === 'cube_load');
  const queryProperties = load.inputSchema.properties.query.properties;
  for (const property of [
    'measures', 'dimensions', 'segments', 'filters', 'timeDimensions', 'order', 'limit',
    'offset', 'total', 'timezone', 'ungrouped', 'subqueryJoins', 'joinHints', 'responseFormat',
  ]) {
    assert.ok(queryProperties[property], `cube_load MCP schema is missing query.${property}`);
  }
});

test('cube_load accepts an object query and returns official results wrapper', async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.close());

  const client = new Client({ name: 'cubebuddy-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(fixture.endpoint, {
    authProvider: { token: async () => GOOD_TOKEN },
  }));
  t.after(() => client.close());

  const result = await client.callTool({
    name: 'cube_load',
    arguments: { query: { measures: ['EmergencyEvents.count'], limit: 20 }, cache: 'stale-if-slow' },
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.queryType, 'regularQuery');
  assert.equal(result.structuredContent.results.length, 1);
  assert.deepEqual(fixture.service.calls[0].query, { measures: ['EmergencyEvents.count'], limit: 20 });
  assert.equal(fixture.service.calls[0].cache, 'stale-if-slow');
  assert.equal(fixture.audit[0].ok, true);
});

test('cube_load validates Cube order formats before calling Cube', async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.close());

  const client = new Client({ name: 'cubebuddy-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(fixture.endpoint, {
    authProvider: { token: async () => GOOD_TOKEN },
  }));
  t.after(() => client.close());

  const invalid = await client.callTool({
    name: 'cube_load',
    arguments: { query: { measures: ['EmergencyEvents.count'], order: [{ 'EmergencyEvents.count': 'desc' }] } },
  });
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /order/i);
  assert.equal(fixture.service.calls.length, 0);

  const objectOrder = await client.callTool({
    name: 'cube_load',
    arguments: { query: { measures: ['EmergencyEvents.count'], order: { 'EmergencyEvents.count': 'desc' } } },
  });
  assert.equal(objectOrder.isError, undefined);

  const multiOrder = await client.callTool({
    name: 'cube_load',
    arguments: { query: { measures: ['EmergencyEvents.count'], order: [['EmergencyEvents.count', 'desc'], ['EmergencyEvents.id', 'asc']] } },
  });
  assert.equal(multiOrder.isError, undefined);
  assert.deepEqual(fixture.service.calls.map((call) => call.query.order), [
    { 'EmergencyEvents.count': 'desc' },
    [['EmergencyEvents.count', 'desc'], ['EmergencyEvents.id', 'asc']],
  ]);
});

test('cube_load rejects malformed documented query structures before calling Cube', async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.close());

  const client = new Client({ name: 'cubebuddy-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(fixture.endpoint, {
    authProvider: { token: async () => GOOD_TOKEN },
  }));
  t.after(() => client.close());

  const invalidQueries = [
    { filters: [{}] },
    { filters: [{ member: 'EmergencyEvents.status', operator: 'equals' }] },
    { filters: [{ or: [] }] },
    { timeDimensions: [{ dimension: 'EmergencyEvents.createdAt', dateRange: 20260101 }] },
    { timeDimensions: [{ dimension: 'EmergencyEvents.createdAt', compareDateRange: [[20260101]] }] },
    { subqueryJoins: [{ sql: 'SELECT 1' }] },
    { joinHints: [['EmergencyEvents']] },
    { order: [['EmergencyEvents.count', 'descending']] },
  ];

  for (const query of invalidQueries) {
    const result = await client.callTool({ name: 'cube_load', arguments: { query } });
    assert.equal(result.isError, true, JSON.stringify(query));
  }
  assert.equal(fixture.service.calls.length, 0);

  const valid = await client.callTool({
    name: 'cube_load',
    arguments: {
      query: {
        measures: ['EmergencyEvents.count'],
        filters: [{ and: [{ member: 'EmergencyEvents.status', operator: 'equals', values: ['open'] }] }],
        timeDimensions: [{
          dimension: 'EmergencyEvents.createdAt',
          dateRange: ['2026-01-01', '2026-01-31'],
          compareDateRange: ['last month', ['2025-12-01', '2025-12-31']],
        }],
        total: true,
        subqueryJoins: [{ sql: 'SELECT 1', on: '1 = 1', joinType: 'left', alias: 'subquery' }],
        joinHints: [['EmergencyEvents', 'EmergencyEventsDetail']],
      },
    },
  });
  assert.equal(valid.isError, undefined);
  assert.equal(fixture.service.calls.length, 1);
});

test('invalid input is rejected and Cube errors remain valid MCP error results', async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.close());

  const client = new Client({ name: 'cubebuddy-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(fixture.endpoint, {
    authProvider: { token: async () => GOOD_TOKEN },
  }));
  t.after(() => client.close());

  const invalid = await client.callTool({ name: 'cube_load', arguments: { query: '{"measures":[]}' } });
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /Invalid|expected|query/i);
  assert.equal(fixture.service.calls.length, 0);

  const result = await client.callTool({ name: 'cube_load', arguments: { query: { fail: true } } });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent, undefined);
  assert.match(result.content[0].text, /模拟 Cube 查询失败/);
  assert.equal(fixture.audit.at(-1).errorCode, 'cube_http_error');
});

test('native MCP rejects missing tokens and insufficient scopes before protocol handling', async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.close());

  const request = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'raw-test', version: '1.0.0' },
    },
  };
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

  const missing = await fetch(fixture.endpoint, { method: 'POST', headers, body: JSON.stringify(request) });
  assert.equal(missing.status, 401);
  assert.match(missing.headers.get('www-authenticate') || '', /Bearer/i);

  const insufficient = await fetch(fixture.endpoint, {
    method: 'POST',
    headers: { ...headers, authorization: 'Bearer wrong-scope' },
    body: JSON.stringify(request),
  });
  assert.equal(insufficient.status, 403);
  assert.match(insufficient.headers.get('www-authenticate') || '', /insufficient_scope/i);
});
