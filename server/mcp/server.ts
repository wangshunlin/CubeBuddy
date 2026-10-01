import { McpServer, type AuthInfo, type CallToolResult } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import {
  cubeLoadInputSchema,
  cubeLoadOutputSchema,
  cubeMetaOutputSchema,
  cubeQuerySchema,
  dryRunOutputSchema,
  glossaryOutputSchema,
} from './contracts.js';

export interface CubeToolService {
  meta(input: { token: string; name?: string }): Promise<Record<string, unknown>>;
  load(input: { token: string; query: Record<string, unknown>; cache?: string }): Promise<Record<string, unknown>>;
  dryRun(input: { token: string; query: Record<string, unknown> }): Promise<Record<string, unknown>>;
  search(input: { token: string; dimension: string; query: string; limit?: number }): Promise<Record<string, unknown>>;
  glossaryResolve(input: { text: string }): Record<string, unknown>;
}

export interface McpAuditEvent {
  tool: string;
  clientId: string;
  ok: boolean;
  durationMs: number;
  errorCode?: string;
}

interface BuildServerOptions {
  service: CubeToolService;
  authInfo?: AuthInfo;
  audit?: (event: McpAuditEvent) => void;
  instructions?: string;
  businessDescription?: string;
}

const DEFAULT_INSTRUCTIONS =
  '先调用 cube_meta 发现模型，再调用 cube_meta_detail 获取真实 member。涉及业务别名时先调用 cube_glossary_resolve。执行查询前可调用 cube_dry_run；禁止猜测 member 名称。';

function asStructured(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('工具返回值必须是 JSON 对象');
  }
  return value as Record<string, unknown>;
}

function success(value: unknown): CallToolResult {
  const structuredContent = asStructured(value);
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

function failure(error: unknown): CallToolResult {
  const value = error as { message?: string; status?: number; code?: string; data?: unknown };
  const message = String(value?.message || '');
  const memberMatch = message.match(/'([^']+)' not found for path '([^']+)'/i);
  let payload: { error: string; status?: number; code: string };

  if (value?.code === 'cube_http_error' && memberMatch) {
    payload = {
      error: `语义成员不可用：${memberMatch[2]}。请重新调用 cube_meta_detail 获取当前可用成员。`,
      status: value.status || 400,
      code: 'member_not_found',
    };
  } else if (value?.code === 'cube_http_error') {
    payload = {
      error: 'Cube 查询被拒绝。请检查查询结构和语义成员后重试。',
      status: value.status || 400,
      code: 'cube_query_invalid',
    };
  } else if (value?.code === 'cube_unavailable') {
    payload = {
      error: 'Cube 服务暂时不可用，请稍后重试。',
      status: value.status || 502,
      code: 'cube_unavailable',
    };
  } else if (value?.code === 'model_not_allowed') {
    payload = {
      error: message || '当前 MCP Server 无权访问该语义模型。',
      status: value.status || 403,
      code: 'model_not_allowed',
    };
  } else {
    payload = {
      error: '工具调用失败，请检查输入后重试。',
      ...(value?.status ? { status: value.status } : {}),
      code: value?.code || 'mcp_tool_error',
    };
  }
  const text = JSON.stringify(payload);
  return {
    content: [{ type: 'text', text }],
    isError: true,
  };
}

async function runTool(
  name: string,
  authInfo: AuthInfo | undefined,
  audit: BuildServerOptions['audit'],
  callback: (token: string) => Promise<unknown> | unknown,
): Promise<CallToolResult> {
  const startedAt = Date.now();
  try {
    if (!authInfo?.token) throw new Error('MCP 请求缺少有效身份');
    const output = await callback(authInfo.token);
    audit?.({ tool: name, clientId: authInfo.clientId, ok: true, durationMs: Date.now() - startedAt });
    return success(output);
  } catch (error) {
    const value = error as { code?: string; status?: number; message?: string; data?: unknown };
    // 原始 Cube 错误仅保留在服务端日志，不能作为 MCP 工具输出透传给调用方。
    console.error('MCP tool failure', {
      tool: name,
      clientId: authInfo?.clientId || 'anonymous',
      code: value?.code,
      status: value?.status,
      message: value?.message || String(error),
      details: value?.data,
    });
    audit?.({
      tool: name,
      clientId: authInfo?.clientId || 'anonymous',
      ok: false,
      durationMs: Date.now() - startedAt,
      errorCode: value?.code,
    });
    return failure(error);
  }
}

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const toolDescriptions: Record<string, string> = require('../../public/mcp-descriptions.json');
function describe(name: string, value = '') {
  const business = String(value || '').trim().slice(0, 1000);
  return business ? `业务范围：\n${business}\n\n工具用途：\n${toolDescriptions[name]}` : toolDescriptions[name];
}

export function buildCubeMcpServer({ service, authInfo, audit, instructions, businessDescription }: BuildServerOptions): McpServer {
  const server = new McpServer(
    { name: 'cubebuddy', version: '1.0.0' },
    {
      instructions: String(instructions || '').trim() || DEFAULT_INSTRUCTIONS,
    },
  );

  server.registerTool(
    'cube_meta',
    {
      title: '发现 Cube 语义模型',
      description: describe('cube_meta', businessDescription),
      outputSchema: cubeMetaOutputSchema,
      annotations: readOnlyAnnotations,
    },
    async () => runTool('cube_meta', authInfo, audit, (token) => service.meta({ token })),
  );

  server.registerTool(
    'cube_meta_detail',
    {
      title: '获取 Cube 模型详情',
      description: describe('cube_meta_detail', businessDescription),
      inputSchema: z.object({
        name: z.string().min(1).describe('cube_meta 返回的 Cube 名称。'),
      }),
      outputSchema: cubeMetaOutputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ name }) => runTool('cube_meta_detail', authInfo, audit, (token) => service.meta({ token, name })),
  );

  server.registerTool(
    'cube_glossary_resolve',
    {
      title: '解析业务术语',
      description: describe('cube_glossary_resolve', businessDescription),
      inputSchema: z.object({ text: z.string().min(1).describe('用户问题或待解析业务短语。') }),
      outputSchema: glossaryOutputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ text }) => runTool('cube_glossary_resolve', authInfo, audit, () => service.glossaryResolve({ text })),
  );

  server.registerTool(
    'cube_search',
    {
      title: '搜索维度值',
      description: describe('cube_search', businessDescription),
      inputSchema: z.object({
        dimension: z.string().min(1).describe('完整维度 member。'),
        query: z.string().min(1).describe('搜索关键词。'),
        limit: z.number().int().min(1).max(500).default(100),
      }),
      outputSchema: cubeLoadOutputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ dimension, query, limit }) => runTool(
      'cube_search',
      authInfo,
      audit,
      (token) => service.search({ token, dimension, query, limit }),
    ),
  );

  server.registerTool(
    'cube_dry_run',
    {
      title: '校验 Cube 查询',
      description: describe('cube_dry_run', businessDescription),
      inputSchema: z.object({ query: cubeQuerySchema }),
      outputSchema: dryRunOutputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ query }) => runTool(
      'cube_dry_run',
      authInfo,
      audit,
      (token) => service.dryRun({ token, query }),
    ),
  );

  server.registerTool(
    'cube_load',
    {
      title: '执行 Cube 语义查询',
      description: describe('cube_load', businessDescription),
      inputSchema: cubeLoadInputSchema,
      outputSchema: cubeLoadOutputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ query, cache }) => runTool(
      'cube_load',
      authInfo,
      audit,
      (token) => service.load({ token, query, cache }),
    ),
  );

  return server;
}
