import * as z from 'zod/v4';

const memberName = z.string().min(1).describe('Cube member 完整名称，必须来自 cube_meta_detail。');
const sortDirection = z.enum(['asc', 'desc']).describe('排序方向：asc 或 desc。');
const dateRangeSchema = z.union([
  z.string(),
  z.array(z.string()).min(1).max(2),
]).describe('日期范围：相对日期字符串，或 [开始日期, 结束日期]。');
const cubeOrderSchema = z.union([
  z.record(memberName, sortDirection),
  z.array(z.tuple([memberName, sortDirection])),
]).describe('Cube 排序配置：单字段或键值映射使用 {"Cube.member":"desc"}；多字段排序使用 [["Cube.member","desc"], ["Cube.other","asc"]]。');

const filterOperatorsWithValues = z.enum([
  'equals', 'notEquals', 'contains', 'notContains', 'startsWith', 'notStartsWith',
  'endsWith', 'notEndsWith', 'gt', 'gte', 'lt', 'lte', 'inDateRange',
  'notInDateRange', 'beforeDate', 'beforeOrOnDate', 'afterDate', 'afterOrOnDate',
]);
const filterOperatorsWithoutValues = z.enum(['set', 'notSet', 'measureFilter']);
const filterValueSchema = z.array(z.string()).min(1).describe('过滤值，至少包含一个字符串。');
const filterItemSchema: z.ZodType = z.lazy(() => z.union([
  z.object({
    member: memberName,
    operator: filterOperatorsWithValues,
    values: filterValueSchema,
  }).passthrough(),
  z.object({
    member: memberName,
    operator: filterOperatorsWithoutValues,
    values: filterValueSchema.optional(),
  }).passthrough(),
  z.object({ or: z.array(filterItemSchema).min(1) }).passthrough(),
  z.object({ and: z.array(filterItemSchema).min(1) }).passthrough(),
])).describe('Cube 过滤条件：成员过滤或非空的 and/or 逻辑组。');

const timeDimensionSchema = z.object({
  dimension: memberName,
  granularity: z.string().optional(),
  dateRange: dateRangeSchema.optional(),
  compareDateRange: z.array(dateRangeSchema).optional(),
}).passthrough().describe('时间维度查询配置。');

const subqueryJoinSchema = z.object({
  sql: z.string(),
  on: z.string(),
  joinType: z.string(),
  alias: z.string(),
}).passthrough();
const joinHintSchema = z.tuple([z.string().min(1), z.string().min(1)]);

export const cubeQuerySchema = z.object({
  measures: z.array(memberName).optional().describe('要查询的度量 member 列表。'),
  dimensions: z.array(memberName).optional().describe('要查询的维度 member 列表。'),
  segments: z.array(memberName).optional().describe('要应用的 segment member 列表。'),
  timeDimensions: z.array(timeDimensionSchema).optional(),
  filters: z.array(filterItemSchema).optional().describe('Cube 查询过滤条件。'),
  order: cubeOrderSchema.optional(),
  limit: z.number().int().min(1).max(500).optional().describe('最大返回行数，原生 MCP 上限为 500。'),
  offset: z.number().int().min(0).optional(),
  total: z.boolean().optional(),
  timezone: z.string().optional(),
  renewQuery: z.boolean().optional(),
  ungrouped: z.boolean().optional(),
  subqueryJoins: z.array(subqueryJoinSchema).optional(),
  joinHints: z.array(joinHintSchema).optional(),
  responseFormat: z.enum(['default', 'compact', 'columnar']).optional(),
}).passthrough().describe('Cube Query Format 单查询对象。');

export const cubeLoadInputSchema = z.object({
  query: cubeQuerySchema,
  cache: z.enum([
    'stale-if-slow',
    'stale-while-revalidate',
    'must-revalidate',
    'no-cache',
  ]).optional().describe('Cube 查询缓存策略。'),
});

export const cubeLoadResultSchema = z.object({
  annotation: z.record(z.string(), z.unknown()),
  data: z.unknown(),
  query: z.unknown().optional(),
  dataSource: z.string().optional(),
  dbType: z.string().optional(),
  extDbType: z.string().optional(),
  external: z.boolean().optional(),
  slowQuery: z.boolean().optional(),
  usedPreAggregations: z.record(z.string(), z.unknown()).optional(),
  refreshKeyValues: z.array(z.record(z.string(), z.unknown())).optional(),
  lastRefreshTime: z.string().optional(),
}).passthrough();

export const cubeLoadOutputSchema = z.object({
  results: z.array(cubeLoadResultSchema),
  queryType: z.string().optional(),
  slowQuery: z.boolean().optional(),
  pivotQuery: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

export const cubeMetaOutputSchema = z.object({
  cubes: z.array(z.record(z.string(), z.unknown())),
  summary: z.boolean(),
  generatedAt: z.number(),
});

const glossaryHitSchema = z.object({
  alias: z.string(),
  standard: z.string(),
  description: z.string(),
});

export const glossaryOutputSchema = z.object({
  ok: z.boolean(),
  hits: z.array(glossaryHitSchema),
});

export const dryRunOutputSchema = z.object({}).passthrough();
