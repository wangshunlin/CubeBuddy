import assert from 'node:assert/strict';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import YAML from 'yaml';

const endpoint = new URL(process.env.MCP_ENDPOINT || 'http://127.0.0.1:28080/mcp');
const token = String(process.env.MCP_TOKEN || '').trim();
const expectedTools = [
  'cube_dry_run',
  'cube_glossary_resolve',
  'cube_load',
  'cube_meta',
  'cube_meta_detail',
  'cube_search',
];
const expectedOpenApiOperations = [
  'cube_glossary_resolve',
  'cube_load',
  'cube_meta',
  'cube_meta_detail',
  'cube_search',
];

if (!token) {
  console.error('缺少 MCP_TOKEN；请通过环境变量传入 CubeBuddy JWT。');
  process.exit(2);
}

const results = [];
let client;

function compactError(error) {
  return String(error?.stack || error?.message || error).replaceAll(token, '<redacted>');
}

async function check(name, callback) {
  const startedAt = performance.now();
  try {
    const details = await callback();
    const durationMs = Math.round(performance.now() - startedAt);
    results.push({ name, ok: true, durationMs, details });
    console.log(`PASS ${name} (${durationMs} ms)${details ? ` - ${details}` : ''}`);
  } catch (error) {
    const durationMs = Math.round(performance.now() - startedAt);
    results.push({ name, ok: false, durationMs, error: compactError(error) });
    console.error(`FAIL ${name} (${durationMs} ms)\n${compactError(error)}`);
  }
}

function rawHeaders(accessToken = token, extra = {}) {
  return {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    ...extra,
  };
}

function initializeRequest(id = 1) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'cubebuddy-e2e', version: '1.0.0' },
    },
  };
}

function assertSuccessfulToolResult(result, name) {
  assert.notEqual(result.isError, true, `${name} 返回 MCP 错误：${result.content?.[0]?.text || '未知错误'}`);
  assert.ok(result.structuredContent && typeof result.structuredContent === 'object', `${name} 缺少 structuredContent`);
  const text = result.content?.find((item) => item.type === 'text')?.text;
  assert.ok(text, `${name} 缺少文本内容`);
  assert.deepEqual(JSON.parse(text), result.structuredContent, `${name} 的文本与 structuredContent 不一致`);
  return result.structuredContent;
}

function findMember(cube, suffix) {
  const all = [...(cube.measures || []), ...(cube.dimensions || []), ...(cube.segments || [])];
  return all.find((member) => member.name === `${cube.name}.${suffix}`)?.name;
}

await check('鉴权：缺少 Bearer JWT 返回 401', async () => {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: rawHeaders(''),
    body: JSON.stringify(initializeRequest()),
  });
  assert.equal(response.status, 401);
  assert.match(response.headers.get('www-authenticate') || '', /Bearer/i);
});

await check('鉴权：无效 JWT 返回 401', async () => {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: rawHeaders('invalid.cubebuddy.token'),
    body: JSON.stringify(initializeRequest()),
  });
  assert.equal(response.status, 401);
});

await check('安全：不受信任 Origin 被拒绝', async () => {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: rawHeaders(token, { origin: 'https://untrusted.invalid' }),
    body: JSON.stringify(initializeRequest()),
  });
  assert.equal(response.status, 403);
});

await check('协议：畸形 JSON 返回 400', async () => {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: rawHeaders(),
    body: '{not-json',
  });
  assert.equal(response.status, 400);
});

await check('协议：官方 SDK 可初始化 Streamable HTTP 会话', async () => {
  client = new Client({ name: 'cubebuddy-e2e', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(endpoint, {
    authProvider: { token: async () => token },
  });
  await client.connect(transport);
  assert.equal(client.getServerVersion()?.name, 'cubebuddy');
  return `${client.getServerVersion()?.name}@${client.getServerVersion()?.version}`;
});

let tools = [];
await check('工具目录：六个只读工具及 Schema 稳定', async () => {
  ({ tools } = await client.listTools());
  assert.deepEqual(tools.map((tool) => tool.name).sort(), expectedTools);
  assert.equal(new Set(tools.map((tool) => tool.name)).size, tools.length, '工具名称重复');
  for (const tool of tools) {
    assert.ok(tool.title, `${tool.name} 缺少 title`);
    assert.ok(tool.description, `${tool.name} 缺少 description`);
    assert.equal(tool.inputSchema?.type, 'object', `${tool.name} inputSchema 不是 object`);
    assert.equal(tool.outputSchema?.type, 'object', `${tool.name} outputSchema 不是 object`);
    assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} 未声明只读`);
    assert.equal(tool.annotations?.destructiveHint, false, `${tool.name} 被错误标记为破坏性`);
    assert.equal(tool.annotations?.idempotentHint, true, `${tool.name} 未声明幂等`);
  }
  const load = tools.find((tool) => tool.name === 'cube_load');
  assert.deepEqual(load.inputSchema.required, ['query']);
  assert.deepEqual(load.outputSchema.required, ['results']);
  assert.equal(load.outputSchema.properties.queryType.type, 'string');
  assert.deepEqual(load.outputSchema.properties.results.items.required, ['annotation', 'data']);
  return expectedTools.join(', ');
});

let cubes = [];
await check('cube_meta：发现非空语义模型摘要', async () => {
  const result = assertSuccessfulToolResult(await client.callTool({ name: 'cube_meta', arguments: {} }), 'cube_meta');
  assert.equal(result.summary, true);
  assert.ok(Number.isFinite(result.generatedAt));
  assert.ok(Array.isArray(result.cubes) && result.cubes.length > 0, '未发现任何 Cube');
  cubes = result.cubes;
  for (const cube of cubes) {
    assert.ok(cube.name && cube.title, 'Cube 摘要缺少 name/title');
    assert.ok(Number.isInteger(cube.measureCount) && Number.isInteger(cube.dimensionCount));
  }
  return `${cubes.length} 个 Cube`;
});

let metadataCube;
await check('cube_meta_detail：元数据目录成员完整且包含数源字段', async () => {
  const summary = cubes.find((cube) => cube.name === 'catalog_items');
  assert.ok(summary, '缺少元数据目录 Cube catalog_items');
  const result = assertSuccessfulToolResult(await client.callTool({
    name: 'cube_meta_detail',
    arguments: { name: summary.name },
  }), 'cube_meta_detail');
  assert.equal(result.summary, false);
  assert.equal(result.cubes.length, 1);
  metadataCube = result.cubes[0];
  assert.equal(metadataCube.name, summary.name);
  for (const suffix of ['count', 'publishname', 'accesssource', 'is_report', 'datatype']) {
    assert.ok(findMember(metadataCube, suffix), `元数据目录缺少 ${suffix} member`);
  }
  const accessSource = metadataCube.dimensions.find((item) => item.name.endsWith('.accesssource'));
  assert.match(accessSource.description || '', /数源部门/);
  return `${metadataCube.measures.length} measures / ${metadataCube.dimensions.length} dimensions`;
});

await check('cube_glossary_resolve：机构 A归一化为示例机构 A', async () => {
  const result = assertSuccessfulToolResult(await client.callTool({
    name: 'cube_glossary_resolve',
    arguments: { text: '机构 A有哪些数据' },
  }), 'cube_glossary_resolve');
  assert.equal(result.ok, true);
  assert.ok(result.hits.some((hit) => hit.alias === '机构 A' && hit.standard === '示例机构 A'));
  return `${result.hits.length} 个命中`;
});

const query = {
  dimensions: [
    'catalog_items.publishname',
    'catalog_items.accesssource',
    'catalog_items.datatype',
  ],
  filters: [{
    member: 'catalog_items.is_report',
    operator: 'equals',
    values: ['是'],
  }],
  limit: 10,
};

await check('cube_search：搜索“是否上报机构 A”维度值', async () => {
  const result = assertSuccessfulToolResult(await client.callTool({
    name: 'cube_search',
    arguments: {
      dimension: 'catalog_items.is_report',
      query: '是',
      limit: 10,
    },
  }), 'cube_search');
  assert.ok(Array.isArray(result.results) && result.results.length > 0);
  const rows = result.results.flatMap((entry) => Array.isArray(entry.data) ? entry.data : []);
  assert.ok(rows.some((row) => Object.values(row).includes('是')), '搜索结果未包含“是”');
  return `${rows.length} 行`;
});

await check('cube_dry_run：用户问题对应查询通过语义校验', async () => {
  const result = assertSuccessfulToolResult(await client.callTool({
    name: 'cube_dry_run',
    arguments: { query },
  }), 'cube_dry_run');
  assert.ok(Array.isArray(result.normalizedQueries), 'dry-run 缺少 normalizedQueries');
  return `${result.normalizedQueries.length} 个规范化查询`;
});

await check('cube_load：查询“机构 A有哪些数据”返回真实数据', async () => {
  const result = assertSuccessfulToolResult(await client.callTool({
    name: 'cube_load',
    arguments: { query },
  }), 'cube_load');
  assert.ok(Array.isArray(result.results) && result.results.length > 0);
  const rows = result.results.flatMap((entry) => Array.isArray(entry.data) ? entry.data : []);
  assert.ok(rows.length > 0, '查询没有返回数据');
  for (const row of rows) {
    assert.ok(Object.hasOwn(row, 'catalog_items.publishname'));
  }
  return `${rows.length} 行`;
});

await check('cube_load 可选参数：cache 与 responseFormat 正常工作', async () => {
  const result = assertSuccessfulToolResult(await client.callTool({
    name: 'cube_load',
    arguments: {
      query: {
        measures: ['catalog_items.count'],
        responseFormat: 'compact',
        limit: 1,
      },
      cache: 'stale-if-slow',
    },
  }), 'cube_load');
  assert.ok(Array.isArray(result.results) && result.results.length > 0);
  assert.notEqual(result.results[0].data, undefined);
  if (result.queryType !== undefined) assert.equal(typeof result.queryType, 'string');
  return `queryType=${result.queryType || 'omitted'}`;
});

await check('输入边界：所有必填参数均由 Schema 拦截', async () => {
  for (const name of ['cube_meta_detail', 'cube_glossary_resolve', 'cube_search', 'cube_dry_run', 'cube_load']) {
    const result = await client.callTool({ name, arguments: {} });
    assert.equal(result.isError, true, `${name} 未拒绝缺失的必填参数`);
  }
});

await check('输入边界：字符串 query 被 Schema 拒绝', async () => {
  const result = await client.callTool({ name: 'cube_load', arguments: { query: '{"measures":[]}' } });
  assert.equal(result.isError, true);
  assert.match(result.content?.[0]?.text || '', /Invalid|expected|query/i);
});

await check('输入边界：超限 limit 被 Schema 拒绝', async () => {
  const result = await client.callTool({
    name: 'cube_search',
    arguments: { dimension: 'catalog_items.is_report', query: '是', limit: 501 },
  });
  assert.equal(result.isError, true);
});

await check('输入边界：未知 cache 策略被 Schema 拒绝', async () => {
  const result = await client.callTool({
    name: 'cube_load',
    arguments: { query: { measures: ['catalog_items.count'] }, cache: 'forever' },
  });
  assert.equal(result.isError, true);
});

await check('错误边界：不存在的 member 返回受控 MCP 错误', async () => {
  const result = await client.callTool({
    name: 'cube_load',
    arguments: { query: { dimensions: ['missing_cube.missing_dimension'], limit: 1 } },
  });
  assert.equal(result.isError, true);
  assert.ok(result.content?.[0]?.text, '错误结果缺少说明');
  assert.equal(result.structuredContent, undefined);
});

await check('错误边界：不存在的工具返回协议错误且会话保持可用', async () => {
  await assert.rejects(client.callTool({ name: 'cube_missing_tool', arguments: {} }), /not found|unknown|method/i);
  const listed = await client.listTools();
  assert.equal(listed.tools.length, expectedTools.length);
});

await check('并发：八个只读调用互不干扰', async () => {
  const calls = Array.from({ length: 8 }, (_, index) => index % 2 === 0
    ? client.callTool({ name: 'cube_glossary_resolve', arguments: { text: '机构 A有哪些数据' } })
    : client.callTool({ name: 'cube_meta', arguments: {} }));
  const responses = await Promise.all(calls);
  assert.ok(responses.every((result) => result.isError !== true));
  return `${responses.length} 个并发调用`;
});

await check('OpenAPI/MCP 边界：OpenAPI 五个操作，dry-run 仅原生 MCP 暴露', async () => {
  const openApiUrl = new URL('/openapi.yaml', endpoint);
  const response = await fetch(openApiUrl);
  assert.equal(response.status, 200);
  const spec = YAML.parse(await response.text());
  const operationIds = Object.values(spec.paths || {})
    .flatMap((pathItem) => Object.values(pathItem || {}))
    .filter((operation) => operation && typeof operation === 'object' && operation.operationId)
    .map((operation) => operation.operationId)
    .sort();
  assert.deepEqual(operationIds, expectedOpenApiOperations);
  assert.equal(operationIds.includes('cube_dry_run'), false);
  assert.equal(tools.some((tool) => tool.name === 'cube_dry_run'), true);
  return `${operationIds.length} OpenAPI / ${tools.length} MCP`;
});

await client?.close().catch(() => {});

const failures = results.filter((result) => !result.ok);
const durations = results.map((result) => result.durationMs).sort((a, b) => a - b);
const p95 = durations[Math.max(0, Math.ceil(durations.length * 0.95) - 1)] || 0;
console.log(`\nSUMMARY ${results.length - failures.length}/${results.length} passed, p95=${p95} ms, endpoint=${endpoint.origin}${endpoint.pathname}`);
if (failures.length) {
  console.error(`FAILED_CASES ${failures.map((result) => result.name).join(' | ')}`);
  process.exitCode = 1;
}
