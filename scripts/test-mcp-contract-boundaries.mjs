#!/usr/bin/env node

import assert from 'node:assert/strict';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const endpoint = process.env.MCP_ENDPOINT;
const token = process.env.MCP_TOKEN;

if (!endpoint || !token) {
  console.error('需要设置 MCP_ENDPOINT 和 MCP_TOKEN。');
  process.exit(2);
}

const expectedTools = [
  'cube_dry_run', 'cube_glossary_resolve', 'cube_load',
  'cube_meta', 'cube_meta_detail', 'cube_search',
];
const candidates = [
  'catalog_items',
  'orders',
  'EmergencyEvents',
];
let passed = 0;
let failed = 0;

function report(ok, name, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
  if (ok) passed += 1;
  else failed += 1;
}

async function expect(name, action) {
  try {
    const detail = await action();
    report(true, name, detail);
  } catch (error) {
    report(false, name, error.message || String(error));
  }
}

async function connect() {
  const client = new Client({ name: 'cubebuddy-contract-boundary-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), {
    authProvider: { token: async () => token },
  }));
  return client;
}

async function withClient(callback) {
  const client = await connect();
  try { return await callback(client); }
  finally { await client.close(); }
}

function errorSource(result) {
  const text = result.content?.[0]?.text || '';
  try { return JSON.parse(text)?.code || 'mcp_schema_error'; }
  catch (_) { return 'mcp_schema_error'; }
}

await expect('协议：缺少鉴权令牌返回 401', async () => {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'negative-test', version: '1' } } }),
  });
  assert.equal(response.status, 401);
  return '401';
});

let model;
let instructions;
let sampleMeasure;
let sampleDimension;
let sampleTimeDimension;
await expect('协议：Streamable HTTP 初始化、工具目录和 instructions', async () => withClient(async (client) => {
  const modelList = await client.listTools();
  assert.deepEqual(modelList.tools.map((tool) => tool.name).sort(), expectedTools);
  assert.ok(client.getInstructions()?.trim(), 'initialize 响应缺少 instructions');

  const meta = await client.callTool({ name: 'cube_meta', arguments: {} });
  assert.equal(meta.isError, undefined);
  const cubes = meta.structuredContent?.cubes;
  assert.ok(Array.isArray(cubes) && cubes.length > 0, 'cube_meta 未返回语义模型');
  const selected = cubes.find((cube) => candidates.includes(cube.name)) || cubes[0];
  assert.equal(typeof selected?.name, 'string');
  model = selected.name;
  instructions = client.getInstructions();
  const detail = await client.callTool({ name: 'cube_meta_detail', arguments: { name: model } });
  assert.equal(detail.isError, undefined);
  const cube = detail.structuredContent?.cubes?.[0];
  sampleMeasure = cube?.measures?.[0]?.name;
  sampleDimension = cube?.dimensions?.[0]?.name;
  sampleTimeDimension = cube?.dimensions?.find((dimension) => dimension.type === 'time')?.name || sampleDimension;
  return `${model} / ${expectedTools.length} tools`;
}));

if (!model) process.exit(1);

await expect('无状态：新建客户端可独立调用 cube_meta', async () => withClient(async (client) => {
  const result = await client.callTool({ name: 'cube_meta', arguments: {} });
  assert.equal(result.isError, undefined);
  return 'fresh client';
}));

await expect('cube_meta_detail：已授权模型可读取详情', async () => withClient(async (client) => {
  const result = await client.callTool({ name: 'cube_meta_detail', arguments: { name: model } });
  assert.equal(result.isError, undefined);
  const cube = result.structuredContent?.cubes?.[0];
  assert.equal(cube?.name, model);
  return model;
}));

await expect('cube_glossary_resolve：术语解析可用', async () => withClient(async (client) => {
  const result = await client.callTool({ name: 'cube_glossary_resolve', arguments: { text: '机构 A' } });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent?.ok, true);
  return `${result.structuredContent.hits?.length || 0} hits`;
}));

await expect('cube_dry_run：最小查询可预校验', async () => withClient(async (client) => {
  const member = sampleMeasure || sampleDimension;
  assert.ok(member, '模型没有可用于查询的 member');
  const query = sampleMeasure ? { measures: [member], limit: 1 } : { dimensions: [member], limit: 1 };
  const result = await client.callTool({ name: 'cube_dry_run', arguments: { query } });
  assert.equal(result.isError, undefined);
  return member;
}));

await expect('cube_load：最小语义查询返回结果包装', async () => withClient(async (client) => {
  const member = sampleMeasure || sampleDimension;
  assert.ok(member, '模型没有可用于查询的 member');
  const query = sampleMeasure ? { measures: [member], limit: 1 } : { dimensions: [member], limit: 1 };
  const result = await client.callTool({ name: 'cube_load', arguments: { query } });
  assert.equal(result.isError, undefined);
  assert.ok(Array.isArray(result.structuredContent?.results));
  return member;
}));

await expect('cube_search：维度值搜索返回标准结果包装', async () => withClient(async (client) => {
  assert.ok(sampleDimension, '模型没有可搜索的维度');
  const result = await client.callTool({ name: 'cube_search', arguments: { dimension: sampleDimension, query: '示例', limit: 1 } });
  assert.equal(result.isError, undefined);
  assert.ok(Array.isArray(result.structuredContent?.results));
  return sampleDimension;
}));

for (const [name, query] of [
  ['order 对象套数组', { order: [{ 'Example.count': 'desc' }] }],
  ['order 非法方向', { order: [['Example.count', 'descending']] }],
  ['filters 空对象', { filters: [{}] }],
  ['filters 缺少 values', { filters: [{ member: sampleDimension, operator: 'equals' }] }],
  ['timeDimensions 非法日期范围', { timeDimensions: [{ dimension: sampleTimeDimension, dateRange: 20260101 }] }],
]) {
  await expect(`输入边界：${name} 被 MCP schema 拦截`, async () => withClient(async (client) => {
    const result = await client.callTool({ name: 'cube_load', arguments: { query } });
    assert.equal(result.isError, true);
    const source = errorSource(result);
    assert.notEqual(source, 'cube_http_error', '错误仍来自 Cube，未在 MCP schema 拦截');
    return source;
  }));
}

console.log(`\nSUMMARY ${passed}/${passed + failed} passed; model=${model}; instructions=${instructions ? 'present' : 'missing'}`);
if (failed) process.exitCode = 1;
