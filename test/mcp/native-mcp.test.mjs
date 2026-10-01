import { modernClientOptions, modernRequest, modernHeaders } from '../../scripts/mcp-protocol.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import test from 'node:test';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import YAML from 'yaml';
import mcpServers from '../../server/lib/mcp-servers.js';

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
        error.data = { stack: '/cube/node_modules/internal.ts:1', requestId: 'internal-request-id' };
        throw error;
      }
      if (input.query.memberMissing === true) {
        const error = new Error("'odsTableName' not found for path 'EmergencyEvents.odsTableName'");
        error.code = 'cube_http_error';
        error.status = 400;
        error.data = { stack: '/cube/node_modules/internal.ts:1', requestId: 'internal-request-id' };
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

async function startFixture({ instructions, service = fakeService() } = {}) {
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

  const client = new Client({ name: 'cubebuddy-test', version: '1.0.0' }, modernClientOptions);
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
  const client = new Client({ name: 'cubebuddy-contract-test', version: '1.0.0' }, modernClientOptions);
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

  const client = new Client({ name: 'cubebuddy-test', version: '1.0.0' }, modernClientOptions);
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

  const client = new Client({ name: 'cubebuddy-test', version: '1.0.0' }, modernClientOptions);
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

  const client = new Client({ name: 'cubebuddy-test', version: '1.0.0' }, modernClientOptions);
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

  const client = new Client({ name: 'cubebuddy-test', version: '1.0.0' }, modernClientOptions);
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
  assert.deepEqual(JSON.parse(result.content[0].text), {
    error: 'Cube 查询被拒绝。请检查查询结构和语义成员后重试。',
    status: 400,
    code: 'cube_query_invalid',
  });
  assert.doesNotMatch(result.content[0].text, /stack|requestId|模拟 Cube 查询失败|\/cube\//i);
  assert.equal(fixture.audit.at(-1).errorCode, 'cube_http_error');

  const missingMember = await client.callTool({ name: 'cube_load', arguments: { query: { memberMissing: true } } });
  assert.equal(missingMember.isError, true);
  assert.deepEqual(JSON.parse(missingMember.content[0].text), {
    error: '语义成员不可用：EmergencyEvents.odsTableName。请重新调用 cube_meta_detail 获取当前可用成员。',
    status: 400,
    code: 'member_not_found',
  });
  assert.doesNotMatch(missingMember.content[0].text, /stack|requestId|\/cube\//i);
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

async function rawModern(fixture, method, { params, headers, token = GOOD_TOKEN, mutate } = {}) {
  const request = modernRequest(method, params);
  mutate?.(request);
  const response = await fetch(fixture.endpoint, {
    method: 'POST', headers: { ...modernHeaders(method, token, params?.name), ...headers },
    body: JSON.stringify(request),
  });
  return { response, body: await response.json() };
}

test('modern raw requests discover and call tools without initialization or session state', async (t) => {
  const fixture = await startFixture({ instructions: '本 Server 的使用说明' });
  t.after(() => fixture.close());
  // Listing first proves discovery is optional and there is no handshake dependency.
  const list = await rawModern(fixture, 'tools/list');
  const discover = await rawModern(fixture, 'server/discover');
  for (const { response, body } of [list, discover]) {
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('mcp-session-id'), null);
    assert.equal(body.result.resultType, 'complete');
    assert.equal(body.result.cacheScope, 'private');
    assert.ok(Number.isInteger(body.result.ttlMs) && body.result.ttlMs >= 0);
    assert.equal(body.result._meta['io.modelcontextprotocol/serverInfo'].name, 'cubebuddy');
  }
  assert.deepEqual(discover.body.result.supportedVersions, ['2026-07-28']);
  assert.equal(discover.body.result.instructions, '本 Server 的使用说明');
  assert.ok(discover.body.result.capabilities.tools);
  assert.equal(discover.body.result.capabilities.resources, undefined);
  assert.equal(discover.body.result.capabilities.prompts, undefined);
  assert.equal(list.body.result.tools.length, 6);
  const repeat = await rawModern(fixture, 'tools/list');
  assert.deepEqual(repeat.body.result.tools, list.body.result.tools);
  const call = await rawModern(fixture, 'tools/call', { params: { name: 'cube_load', arguments: { query: { measures: ['EmergencyEvents.count'] } } } });
  assert.equal(call.response.status, 200);
  assert.equal(call.body.result.resultType, 'complete');
  assert.equal(call.body.result.structuredContent.results.length, 1);
});

test('modern protocol rejects invalid metadata and mismatched HTTP headers', async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  for (const mutate of [
    request => { delete request.params._meta; },
    request => { delete request.params._meta['io.modelcontextprotocol/clientCapabilities']; },
  ]) {
    const { response, body } = await rawModern(fixture, 'tools/list', { mutate });
    assert.equal(response.status, 400);
    assert.ok(body.error);
  }
  for (const headers of [
    { 'Mcp-Method': 'server/discover' },
    { 'MCP-Protocol-Version': '2025-11-25' },
  ]) {
    const { response, body } = await rawModern(fixture, 'tools/list', { headers });
    assert.equal(response.status, 400);
    assert.equal(body.error.code, -32020);
  }
  const nameMismatch = await rawModern(fixture, 'tools/call', {
    params: { name: 'cube_load', arguments: { query: {} } },
    headers: { 'Mcp-Name': 'cube_meta' },
  });
  assert.equal(nameMismatch.response.status, 400);
  assert.equal(nameMismatch.body.error.code, -32020);
  const unsupported = await rawModern(fixture, 'tools/list', {
    headers: { 'MCP-Protocol-Version': '2099-01-01' },
    mutate: request => { request.params._meta['io.modelcontextprotocol/protocolVersion'] = '2099-01-01'; },
  });
  assert.equal(unsupported.body.error.code, -32022);
});

test('modern discovery and direct calls require authorization and sufficient scope', async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  for (const method of ['server/discover', 'tools/list', 'tools/call']) {
    const params = method === 'tools/call' ? { name: 'cube_load', arguments: { query: {} } } : {};
    for (const [token, status] of [['', 401], ['invalid', 401], ['wrong-scope', 403]]) {
      const { response } = await rawModern(fixture, method, { token, params });
      assert.equal(response.status, status);
    }
  }
  assert.equal(fixture.service.calls.length, 0);
});

test('legacy client can still initialize and list tools', async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const client = new Client({ name: 'legacy-test', version: '1' }, { versionNegotiation: { mode: 'legacy' } });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(fixture.endpoint, { authProvider: { token: async () => GOOD_TOKEN } }));
  assert.equal((await client.listTools()).tools.length, 6);
  assert.ok(client.getInstructions());
});

test('modern direct tool calls enforce model bindings before reaching Cube', async (t) => {
  const source = fakeService();
  source.meta = async () => ({ cubes: [{ name: 'orders' }, { name: 'finance' }] });
  const fixture = await startFixture({ service: mcpServers.createScopedCubeToolService(source, {
    id: 'sales', modelIds: ['orders'], enabled: true,
  }) });
  t.after(() => fixture.close());
  const meta = await rawModern(fixture, 'tools/call', { params: { name: 'cube_meta', arguments: {} } });
  assert.deepEqual(meta.body.result.structuredContent.cubes, [{ name: 'orders' }]);
  for (const [name, args] of [
    ['cube_meta_detail', { name: 'finance' }],
    ['cube_load', { query: { measures: ['finance.count'] } }],
    ['cube_dry_run', { query: { measures: ['finance.count'] } }],
    ['cube_search', { dimension: 'finance.region', query: '示例' }],
  ]) {
    const result = await rawModern(fixture, 'tools/call', { params: { name, arguments: args } });
    assert.equal(result.body.result.resultType, 'complete');
    assert.equal(result.body.result.isError, true);
    assert.equal(JSON.parse(result.body.result.content[0].text).code, 'model_not_allowed');
  }
  assert.equal(source.calls.length, 0);
});
