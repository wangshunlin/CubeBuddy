import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { fetchExternalMcpTools } from '../../server/lib/mcp-client.js';

for (const legacy of [false, true]) {
  for (const sse of [false, true]) {
    test(`external client negotiates ${legacy ? 'legacy' : 'modern'} protocol and reads ${sse ? 'SSE' : 'JSON'} tools`, async (t) => {
      const requests = [];
      const server = http.createServer(async (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405).end(); return; }
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const message = JSON.parse(raw);
        requests.push({ message, headers: req.headers });
        const common = { capabilities: { tools: {} }, serverInfo: { name: 'external-test', version: '1' } };
        let result;
        if (message.method === 'server/discover') {
          if (legacy) {
            res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unknown method' } }));
            return;
          }
          result = { resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: common.capabilities, _meta: { 'io.modelcontextprotocol/serverInfo': common.serverInfo }, ttlMs: 0, cacheScope: 'private' };
        } else if (message.method === 'initialize') result = { ...common, protocolVersion: '2025-11-25' };
        else if (message.method === 'notifications/initialized') { res.writeHead(202).end(); return; }
        else if (message.method === 'tools/list') result = {
          ...(legacy ? {} : { resultType: 'complete', ttlMs: 0, cacheScope: 'private' }),
          tools: [{ name: 'sample', description: '示例', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }],
        };
        else { res.writeHead(400).end(); return; }
        const body = JSON.stringify({ jsonrpc: '2.0', id: message.id, result });
        if (sse) res.writeHead(200, { 'content-type': 'text/event-stream' }).end(`event: message\ndata: ${body}\n\n`);
        else res.writeHead(200, { 'content-type': 'application/json' }).end(body);
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      t.after(() => new Promise(resolve => server.close(resolve)));
      const tools = await fetchExternalMcpTools(`http://127.0.0.1:${server.address().port}/mcp`, 'test-api-key');
      assert.deepEqual(tools, [{ name: 'sample', description: '示例', params: ['query'] }]);
      assert.equal(requests[0].message.method, 'server/discover');
      assert.equal(requests.some(({ message }) => message.method === 'initialize'), legacy);
      assert.ok(requests.every(({ headers }) => headers['x-api-key'] === 'test-api-key'));
      const list = requests.find(({ message }) => message.method === 'tools/list');
      if (!legacy) {
        assert.equal(list.message.params._meta['io.modelcontextprotocol/protocolVersion'], '2026-07-28');
        assert.equal(list.headers['mcp-method'], 'tools/list');
      }
    });
  }
}
