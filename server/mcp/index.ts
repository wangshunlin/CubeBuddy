import {
  OAuthError,
  OAuthErrorCode,
  createMcpHandler,
  hostHeaderValidationResponse,
  originValidationResponse,
  requireBearerAuth,
  type AuthInfo,
  type DiscoverResult,
  type ListToolsResult,
} from '@modelcontextprotocol/server';
import { toNodeHandler, type NodeIncomingMessageLike, type NodeServerResponseLike } from '@modelcontextprotocol/node';

import { buildCubeMcpServer, type CubeToolService, type McpAuditEvent } from './server.js';

interface NativeMcpOptions {
  service: CubeToolService;
  verifyAccessToken: (token: string) => Promise<AuthInfo> | AuthInfo;
  allowedHosts: string[];
  allowedOrigins: string[];
  instructions?: string;
  businessDescription?: string;
  audit?: (event: McpAuditEvent) => void;
  onerror?: (error: Error) => void;
}

export function createNativeMcp(options: NativeMcpOptions) {
  const handler = createMcpHandler(
    ({ authInfo }) => buildCubeMcpServer({ service: options.service, authInfo, audit: options.audit, instructions: options.instructions, businessDescription: options.businessDescription }),
    {
      legacy: 'stateless',
      onerror: options.onerror,
    },
  );

  const authGate = requireBearerAuth({
    verifier: {
      async verifyAccessToken(token) {
        try {
          return await options.verifyAccessToken(token);
        } catch (error) {
          if (error instanceof OAuthError) throw error;
          throw new OAuthError(OAuthErrorCode.InvalidToken, '无效或已撤销的 CubeBuddy JWT');
        }
      },
    },
    requiredScopes: ['cube:read'],
  });

  const nodeHandler = toNodeHandler(
    {
      async fetch(request, requestOptions) {
        const hostRejection = hostHeaderValidationResponse(request, options.allowedHosts);
        if (hostRejection) return hostRejection;
        const originRejection = originValidationResponse(request, options.allowedOrigins);
        if (originRejection) return originRejection;

        const authInfo = await authGate(request);
        if (authInfo instanceof Response) return authInfo;
        return handler.fetch(request, { ...requestOptions, authInfo });
      },
    },
    { onerror: options.onerror },
  );

  return {
    // Admin-only callers inspect the actual protocol handler without minting a service key.
    // This checks local protocol responses, not public proxy connectivity or JWT validation.
    async diagnostics() {
      async function inspect<T extends DiscoverResult | ListToolsResult>(method: string): Promise<T> {
        const response = await handler.fetch(new Request('http://localhost/mcp', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'MCP-Protocol-Version': '2026-07-28',
            'Mcp-Method': method,
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params: { _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
            'io.modelcontextprotocol/clientInfo': { name: 'cubebuddy-console', version: '1.0.0' },
          } } }),
        }), { authInfo: {
          token: '', clientId: 'console-diagnostics', scopes: ['cube:read'], expiresAt: 253402300799,
        } });
        const body = await response.json() as { result?: T; error?: { message?: string } };
        if (!response.ok || !body.result) throw new Error(body.error?.message || `MCP ${method}: HTTP ${response.status}`);
        if (body.result.resultType !== 'complete' || response.headers.has('mcp-session-id')
          || typeof body.result.ttlMs !== 'number' || !Number.isInteger(body.result.ttlMs) || body.result.ttlMs < 0
          || (body.result.cacheScope !== 'private' && body.result.cacheScope !== 'public')) {
          throw new Error(`MCP ${method}: 新版协议响应无效`);
        }
        return body.result;
      }
      const discovery = await inspect<DiscoverResult>('server/discover');
      const catalog = await inspect<ListToolsResult>('tools/list');
      if (!discovery.supportedVersions.includes('2026-07-28') || !discovery.capabilities.tools) {
        throw new Error('MCP 发现结果未声明新版协议或工具能力');
      }
      return {
        checkedAt: new Date().toISOString(),
        scope: 'local',
        discovery,
        tools: catalog.tools.map((tool) => tool.name),
        cache: { ttlMs: catalog.ttlMs, cacheScope: catalog.cacheScope },
      };
    },
    handle(req: NodeIncomingMessageLike, res: NodeServerResponseLike) {
      return nodeHandler(req, res);
    },
    close() {
      return handler.close();
    },
  };
}

export type { CubeToolService, McpAuditEvent } from './server.js';
