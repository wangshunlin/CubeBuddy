import {
  OAuthError,
  OAuthErrorCode,
  createMcpHandler,
  hostHeaderValidationResponse,
  originValidationResponse,
  requireBearerAuth,
  type AuthInfo,
} from '@modelcontextprotocol/server';
import { toNodeHandler, type NodeIncomingMessageLike, type NodeServerResponseLike } from '@modelcontextprotocol/node';

import { buildCubeMcpServer, type CubeToolService, type McpAuditEvent } from './server.js';

interface NativeMcpOptions {
  service: CubeToolService;
  verifyAccessToken: (token: string) => Promise<AuthInfo> | AuthInfo;
  allowedHosts: string[];
  allowedOrigins: string[];
  instructions?: string;
  audit?: (event: McpAuditEvent) => void;
  onerror?: (error: Error) => void;
}

export function createNativeMcp(options: NativeMcpOptions) {
  const handler = createMcpHandler(
    ({ authInfo }) => buildCubeMcpServer({ service: options.service, authInfo, audit: options.audit, instructions: options.instructions }),
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
    handle(req: NodeIncomingMessageLike, res: NodeServerResponseLike) {
      return nodeHandler(req, res);
    },
    close() {
      return handler.close();
    },
  };
}

export type { CubeToolService, McpAuditEvent } from './server.js';
