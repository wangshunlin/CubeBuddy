import fs from 'node:fs';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import mysql from 'mysql2/promise';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

if (!process.env.MCP_ENDPOINT) throw new Error('MCP_ENDPOINT 必填');
const endpoint = new URL(process.env.MCP_ENDPOINT);
const token = String(process.env.MCP_TOKEN || '').trim();
const outputPath = String(process.env.BENCHMARK_OUTPUT || '').trim();
if (!token) throw new Error('缺少 MCP_TOKEN');

const dbConfig = {
  host: process.env.CUBEJS_DS_ANALYTICS_DB_DB_HOST || process.env.CUBEJS_DB_HOST,
  port: Number(process.env.CUBEJS_DS_ANALYTICS_DB_DB_PORT || process.env.CUBEJS_DB_PORT || 3306),
  user: process.env.CUBEJS_DS_ANALYTICS_DB_DB_USER || process.env.CUBEJS_DB_USER,
  password: process.env.CUBEJS_DS_ANALYTICS_DB_DB_PASS || process.env.CUBEJS_DB_PASS,
  database: process.env.CUBEJS_DS_ANALYTICS_DB_DB_NAME || process.env.CUBEJS_DB_NAME || 'analytics_db',
  connectTimeout: 10000,
};

const cases = [
  {
    id: 'metadata-emergency-source',
    table: 'catalog_items',
    question: '示例机构 A作为数源部门有哪些数据？请按数据类型汇总。',
    cube: 'catalog_items',
    query: {
      dimensions: ['catalog_items.accesssource', 'catalog_items.datatype'],
      measures: ['catalog_items.count'],
      filters: [{ member: 'catalog_items.accesssource', operator: 'equals', values: ['示例机构 A'] }],
      limit: 100,
    },
    sql: `SELECT accessSource AS accesssource, dataType AS datatype, COUNT(*) AS count
          FROM analytics_db.catalog_items
          WHERE accessSource = ? GROUP BY accessSource, dataType ORDER BY count DESC, datatype`,
    params: ['示例机构 A'],
    dimensions: ['accesssource', 'datatype'],
    measures: ['count'],
    label: '数据类型',
  },
  {
    id: 'metadata-reported-to-ministry',
    table: 'catalog_items',
    question: '哪些数据已经上报示例机构 A？请按数源部门和数据类型汇总。',
    cube: 'catalog_items',
    query: {
      dimensions: ['catalog_items.accesssource', 'catalog_items.datatype'],
      measures: ['catalog_items.count'],
      filters: [{ member: 'catalog_items.is_report', operator: 'equals', values: ['是'] }],
      limit: 100,
    },
    sql: `SELECT accessSource AS accesssource, dataType AS datatype, COUNT(*) AS count
          FROM analytics_db.catalog_items
          WHERE is_Report = ? GROUP BY accessSource, dataType ORDER BY count DESC, accesssource, datatype`,
    params: ['是'],
    dimensions: ['accesssource', 'datatype'],
    measures: ['count'],
    label: '数源部门/数据类型',
  },
  {
    id: 'metadata-weather-bureau',
    table: 'catalog_items',
    question: '示例机构 B接入了哪些类型的数据？接口和电子文件分别有多少？',
    cube: 'catalog_items',
    query: {
      dimensions: ['catalog_items.accesssource', 'catalog_items.datatype'],
      measures: ['catalog_items.count'],
      filters: [{ member: 'catalog_items.accesssource', operator: 'equals', values: ['示例机构 B'] }],
      limit: 100,
    },
    sql: `SELECT accessSource AS accesssource, dataType AS datatype, COUNT(*) AS count
          FROM analytics_db.catalog_items
          WHERE accessSource = ? GROUP BY accessSource, dataType ORDER BY count DESC, datatype`,
    params: ['示例机构 B'],
    dimensions: ['accesssource', 'datatype'],
    measures: ['count'],
    label: '数据类型',
  },
  {
    id: 'metadata-all-data-types',
    table: 'catalog_items',
    question: 'analytics_db 中各类数据类型分别有多少条？',
    cube: 'catalog_items',
    query: { dimensions: ['catalog_items.datatype'], measures: ['catalog_items.count'], limit: 100 },
    sql: `SELECT dataType AS datatype, COUNT(*) AS count
          FROM analytics_db.catalog_items GROUP BY dataType ORDER BY count DESC, datatype`,
    params: [],
    dimensions: ['datatype'],
    measures: ['count'],
    label: '数据类型',
  },
  {
    id: 'shelter-by-area',
    table: 'facility_records',
    question: '避难场所按行政区名称分布如何？请列出数量最多的前 10 个区域。',
    cube: 'facility_records',
    query: { dimensions: ['facility_records.areaname'], measures: ['facility_records.count'], limit: 10 },
    sql: `SELECT areaName AS areaname, COUNT(*) AS count
          FROM analytics_db.facility_records GROUP BY areaName ORDER BY count DESC, areaname LIMIT 10`,
    params: [],
    dimensions: ['areaname'],
    measures: ['count'],
    label: '区域',
  },
  {
    id: 'shelter-by-audit-status',
    table: 'facility_records',
    question: '避难场所按审核状态分别有多少个？',
    cube: 'facility_records',
    query: { dimensions: ['facility_records.auditstat'], measures: ['facility_records.count'], limit: 100 },
    sql: `SELECT auditStat AS auditstat, COUNT(*) AS count
          FROM analytics_db.facility_records GROUP BY auditStat ORDER BY count DESC, auditstat`,
    params: [],
    dimensions: ['auditstat'],
    measures: ['count'],
    label: '审核状态',
  },
  {
    id: 'rescue-guangzhou-total',
    table: 'team_records',
    question: '示例城市全域有多少支队伍，动员人数是多少？',
    cube: 'team_records',
    query: {
      dimensions: ['team_records.prefecture_code'],
      measures: ['team_records.count', 'team_records.mobilized_count'],
      filters: [{ member: 'team_records.prefecture_code', operator: 'equals', values: ['1001'] }],
      limit: 10,
    },
    sql: `SELECT LEFT(TRIM(city_code), 4) AS prefecture_code, COUNT(*) AS count, SUM(mobilized_count) AS mobilized_count
          FROM analytics_db.team_records WHERE LEFT(TRIM(city_code), 4) = ?
          GROUP BY LEFT(TRIM(city_code), 4)`,
    params: ['1001'],
    dimensions: ['prefecture_code'],
    measures: ['count', 'mobilized_count'],
    label: '地市前缀',
    semanticNote: '使用派生地市编码；city_name=示例城市仅命中地市本级记录。',
  },
  {
    id: 'rescue-guangzhou-by-team-type',
    table: 'team_records',
    question: '示例城市全域队伍按队伍类型如何分布？',
    cube: 'team_records',
    query: {
      dimensions: ['team_records.team_type'],
      measures: ['team_records.count'],
      filters: [{ member: 'team_records.prefecture_code', operator: 'equals', values: ['1001'] }],
      limit: 100,
    },
    sql: `SELECT team_type, COUNT(*) AS count
          FROM analytics_db.team_records WHERE LEFT(TRIM(city_code), 4) = ?
          GROUP BY team_type ORDER BY count DESC, team_type`,
    params: ['1001'],
    dimensions: ['team_type'],
    measures: ['count'],
    label: '队伍类型',
    semanticNote: '使用 prefecture_code=1001 覆盖示例城市下属区县和街道记录。',
  },
  {
    id: 'rescue-guangzhou-city-name-control',
    table: 'team_records',
    question: '【错误基线】如果只用 city_name=示例城市 精确匹配，会得到多少支队伍？',
    cube: 'team_records',
    query: {
      dimensions: ['team_records.city_name'],
      measures: ['team_records.count', 'team_records.mobilized_count'],
      filters: [{ member: 'team_records.city_name', operator: 'equals', values: ['示例城市'] }],
      limit: 10,
    },
    sql: `SELECT city_name, COUNT(*) AS count, SUM(mobilized_count) AS mobilized_count
          FROM analytics_db.team_records WHERE city_name = ? GROUP BY city_name`,
    params: ['示例城市'],
    dimensions: ['city_name'],
    measures: ['count', 'mobilized_count'],
    label: '城市名称（错误基线）',
    semanticControl: true,
    semanticNote: '仅命中城市本级记录；不能代表完整区域。正确口径应使用派生的 region_code。',
  },
  {
    id: 'equipment-by-type',
    table: 'equipment_records',
    question: '装备按装备类型的数量和可用数量如何分布？请列出可用数量最多的前 10 类。',
    cube: 'equipment_records',
    query: { dimensions: ['equipment_records.equipment_type'], measures: ['equipment_records.count', 'equipment_records.available_quantity'], order: { 'equipment_records.available_quantity': 'desc', 'equipment_records.equipment_type': 'asc' }, limit: 10 },
    sql: `SELECT equipment_type, COUNT(*) AS count, SUM(available_quantity) AS available_quantity
          FROM analytics_db.equipment_records GROUP BY equipment_type
          ORDER BY available_quantity DESC, equipment_type LIMIT 10`,
    params: [],
    dimensions: ['equipment_type'],
    measures: ['count', 'available_quantity'],
    label: '装备类型',
  },
  {
    id: 'warehouse-by-first-category',
    table: 'inventory_records',
    question: '库存物资库存按一级分类如何分布？请列出库存记录最多的前 10 类。',
    cube: 'inventory_records',
    query: { dimensions: ['inventory_records.first_category_name'], measures: ['inventory_records.count'], limit: 10 },
    sql: `SELECT first_category_name, COUNT(*) AS count
          FROM analytics_db.inventory_records GROUP BY first_category_name
          ORDER BY count DESC, first_category_name LIMIT 10`,
    params: [],
    dimensions: ['first_category_name'],
    measures: ['count'],
    label: '一级分类',
  },
  {
    id: 'warehouse-by-level',
    table: 'inventory_records',
    question: '库存物资库存按仓库级别如何分布？',
    cube: 'inventory_records',
    query: { dimensions: ['inventory_records.level_name'], measures: ['inventory_records.count'], limit: 100 },
    sql: `SELECT level_name, COUNT(*) AS count
          FROM analytics_db.inventory_records GROUP BY level_name ORDER BY count DESC, level_name`,
    params: [],
    dimensions: ['level_name'],
    measures: ['count'],
    label: '仓库级别',
  },
  {
    id: 'rescue-vehicle-total',
    table: 'vehicle_records',
    question: '队伍车辆信息共有多少条？',
    cube: 'vehicle_records',
    query: { measures: ['vehicle_records.count'], limit: 1 },
    sql: `SELECT COUNT(*) AS count FROM analytics_db.vehicle_records`,
    params: [],
    dimensions: [],
    measures: ['count'],
    label: '车辆记录',
  },
];

function compactError(error) {
  return String(error?.stack || error?.message || error).replaceAll(token, '<redacted>').replace(/\s+/g, ' ').slice(0, 500);
}

function memberSuffix(key) {
  return String(key || '').split('.').at(-1) || String(key || '');
}

function normalizedValue(value, field) {
  if (value === null || value === undefined || value === '') return null;
  const name = memberSuffix(field);
  if (name === 'count' || name.endsWith('_count') || name === 'available_quantity') {
    const number = Number(value);
    return Number.isFinite(number) ? number : String(value);
  }
  return String(value);
}

function normalizeRows(rows, test) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const out = {};
    for (const field of [...test.dimensions, ...test.measures]) {
      const suffix = memberSuffix(field);
      const key = Object.keys(row || {}).find((candidate) => memberSuffix(candidate) === suffix);
      out[suffix] = normalizedValue(key === undefined ? null : row[key], suffix);
    }
    return out;
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'zh-CN'));
}

function answerFromRows(test, rows) {
  if (!rows.length) return '查询无结果。';
  if (!test.dimensions.length) return `共 ${rows[0].count ?? '—'} 条记录。`;
  const label = test.label || test.dimensions.join('/');
  const parts = rows.slice(0, 10).map((row) => {
    const dimension = test.dimensions.map((field) => row[memberSuffix(field)] ?? '未分类').join('/');
    const metrics = test.measures.map((field) => `${memberSuffix(field)}=${row[memberSuffix(field)] ?? '—'}`).join('，');
    return `${dimension}（${metrics}）`;
  });
  return `按${label}统计，共 ${rows.length} 个分组；${parts.join('、')}。`;
}

async function runMcp(test) {
  const startedAt = performance.now();
  const client = new Client({ name: 'mcp-vs-db-benchmark', version: '1.0.0' });
  try {
    const connectStarted = performance.now();
    await client.connect(new StreamableHTTPClientTransport(endpoint, { authProvider: { token: async () => token } }));
    const connectedMs = Math.round(performance.now() - connectStarted);
    const callStarted = performance.now();
    const result = await client.callTool({ name: 'cube_load', arguments: { query: test.query } });
    const toolMs = Math.round(performance.now() - callStarted);
    if (result.isError) throw new Error(result.content?.[0]?.text || 'MCP 工具返回错误');
    const rows = (result.structuredContent?.results || []).flatMap((entry) => Array.isArray(entry.data) ? entry.data : []);
    const normalized = normalizeRows(rows, test);
    const answerStarted = performance.now();
    const answer = answerFromRows(test, normalized);
    const answerMs = Math.round(performance.now() - answerStarted);
    return { ok: true, totalMs: Math.round(performance.now() - startedAt), connectedMs, toolMs, answerMs, rows: normalized, answer };
  } catch (error) {
    return { ok: false, totalMs: Math.round(performance.now() - startedAt), error: compactError(error) };
  } finally {
    await client.close().catch(() => {});
  }
}

async function runDb(test) {
  const startedAt = performance.now();
  let connection;
  try {
    const connectStarted = performance.now();
    connection = await mysql.createConnection(dbConfig);
    const connectedMs = Math.round(performance.now() - connectStarted);
    const queryStarted = performance.now();
    const [rows] = await connection.execute(test.sql, test.params);
    const queryMs = Math.round(performance.now() - queryStarted);
    const normalized = normalizeRows(rows, test);
    const answerStarted = performance.now();
    const answer = answerFromRows(test, normalized);
    const answerMs = Math.round(performance.now() - answerStarted);
    return { ok: true, totalMs: Math.round(performance.now() - startedAt), connectedMs, queryMs, answerMs, rows: normalized, answer };
  } catch (error) {
    return { ok: false, totalMs: Math.round(performance.now() - startedAt), error: compactError(error) };
  } finally {
    await connection?.end().catch(() => {});
  }
}

const startedAt = new Date().toISOString();
const results = [];
for (const test of cases) {
  const mcp = await runMcp(test);
  const db = await runDb(test);
  const match = mcp.ok && db.ok && JSON.stringify(mcp.rows) === JSON.stringify(db.rows);
  results.push({
    id: test.id,
    table: test.table,
    question: test.question,
    semanticNote: test.semanticNote || '',
    mcp,
    db,
    comparison: {
      exactResultMatch: match,
      mcpMinusDbMs: mcp.ok && db.ok ? mcp.totalMs - db.totalMs : null,
      quality: test.semanticControl ? '陷阱对照' : (match ? '结果一致' : '需复核'),
      semanticControl: Boolean(test.semanticControl),
    },
  });
  console.log(`${test.id}: MCP=${mcp.ok ? `${mcp.totalMs}ms` : 'FAIL'} DB=${db.ok ? `${db.totalMs}ms` : 'FAIL'} match=${match}`);
}

const successful = results.filter((item) => item.mcp.ok && item.db.ok);
const businessCases = successful.filter((item) => !item.comparison.semanticControl);
const matches = businessCases.filter((item) => item.comparison.exactResultMatch);
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] : null;
};
const summary = {
  startedAt,
  finishedAt: new Date().toISOString(),
  endpoint: endpoint.href,
  scope: 'analytics_db 业务表；每个方案均包含一次新连接、执行和确定性答案格式化。',
  limitation: '未注入真实 LLM Agent，因此 totalMs 不包含不可观测的模型推理时间；它代表可复现的检索闭环耗时。',
  caseCount: results.length,
  businessCaseCount: businessCases.length,
  semanticControlCount: successful.length - businessCases.length,
  successfulCaseCount: successful.length,
  exactMatchCount: matches.length,
  exactMatchRate: businessCases.length ? matches.length / businessCases.length : 0,
  mcp: {
    meanMs: successful.length ? Math.round(successful.reduce((sum, item) => sum + item.mcp.totalMs, 0) / successful.length) : null,
    p50Ms: percentile(successful.map((item) => item.mcp.totalMs), 0.5),
    p95Ms: percentile(successful.map((item) => item.mcp.totalMs), 0.95),
  },
  db: {
    meanMs: successful.length ? Math.round(successful.reduce((sum, item) => sum + item.db.totalMs, 0) / successful.length) : null,
    p50Ms: percentile(successful.map((item) => item.db.totalMs), 0.5),
    p95Ms: percentile(successful.map((item) => item.db.totalMs), 0.95),
  },
};
const payload = { summary, results };
if (outputPath) fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2), 'utf8');
console.log(JSON.stringify(summary, null, 2));
if (results.some((item) => !item.mcp.ok || !item.db.ok || !item.comparison.exactResultMatch)) process.exitCode = 1;
