'use strict';

async function fetchExternalMcpTools(endpoint, key) {
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const client = new Client({ name: 'cube-admin-ui', version: '1.0' }, {
    versionNegotiation: { mode: 'auto', probe: { timeoutMs: 10000 } },
  });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { 'X-API-Key': key } },
  });
  try {
    await client.connect(transport, { timeout: 10000 });
    const { tools } = await client.listTools({}, { timeout: 10000 });
    return tools.map((tool) => ({
      name: tool.name,
      description: String(tool.description || '').slice(0, 300),
      params: Object.keys(tool.inputSchema?.properties || {}),
    }));
  } finally {
    await client.close();
  }
}

module.exports = { fetchExternalMcpTools };
