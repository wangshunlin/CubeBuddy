// Raw modern requests complement SDK tests: no legacy fallback can hide regressions.
export const MCP_PROTOCOL_VERSION = '2026-07-28';
export const modernClientOptions = { versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } } };

export function modernRequest(method, params = {}, id = 1) {
  return { jsonrpc: '2.0', id, method, params: { ...params, _meta: {
    'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
    'io.modelcontextprotocol/clientCapabilities': {},
    'io.modelcontextprotocol/clientInfo': { name: 'cubebuddy-protocol-test', version: '1.0.0' },
  } } };
}

export function modernHeaders(method, token, name) {
  return {
    'content-type': 'application/json', accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': MCP_PROTOCOL_VERSION, 'Mcp-Method': method,
    ...(name ? { 'Mcp-Name': name } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}
