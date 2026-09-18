import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import jwtlib from '../../server/lib/jwt.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const ADMIN_TOKEN = 'integration-admin-token';
const JWT_SECRET = 'integration-secret-with-sufficient-length';

async function startCubeBuddy(prepare) {
  const deployDir = await mkdtemp(path.join(tmpdir(), 'cubebuddy-mcp-test-'));
  if (prepare) await prepare(deployDir);
  const child = spawn(process.execPath, ['server/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: '0',
      NODE_ENV: 'test',
      CUBE_DEPLOY_DIR: deployDir,
      CUBE_OPENAPI_PATH: path.join(ROOT, 'server/openapi/openapi.yaml'),
      CUBE_UI_ADMIN_TOKEN: ADMIN_TOKEN,
      CUBEJS_API_SECRET: JWT_SECRET,
      CUBE_API_BASE: 'http://127.0.0.1:9',
      CUBE_PUBLIC_BASE: 'http://127.0.0.1',
      CONSOLE_PUBLIC_BASE: 'http://127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const endpoint = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`CubeBuddy 启动超时：${output}`)), 10000);
    const onData = (chunk) => {
      output += chunk.toString();
      const match = output.match(/原生 MCP: http:\/\/127\.0\.0\.1:(\d+)\/mcp/);
      if (!match) return;
      clearTimeout(timeout);
      resolve(new URL(`http://127.0.0.1:${match[1]}/mcp`));
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`CubeBuddy 提前退出（${code}）：${output}`));
    });
    child.once('error', reject);
  });

  return {
    child,
    deployDir,
    endpoint,
    async close() {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await new Promise((resolve) => child.once('exit', resolve));
      }
      await rm(deployDir, { recursive: true, force: true });
    },
  };
}

async function adminRequest(endpoint, pathname, options = {}) {
  const url = new URL(pathname, endpoint);
  const response = await fetch(url, {
    ...options,
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await response.json();
  assert.equal(response.ok, true, JSON.stringify(data));
  return data;
}

test('real CubeBuddy server issues, verifies and revokes native MCP tokens', async (t) => {
  const fixture = await startCubeBuddy(async (deployDir) => {
    await mkdir(path.join(deployDir, 'schema'), { recursive: true });
    await writeFile(path.join(deployDir, 'schema', 'orders.yml'), 'cubes:\n  - name: orders\n');
  });
  t.after(() => fixture.close());
  await adminRequest(fixture.endpoint, '/api/mcp-servers', { method: 'POST', body: JSON.stringify({ id: 'test-agent', modelIds: ['orders'] }) });

  const issued = await adminRequest(fixture.endpoint, '/api/mcp-servers/test-agent/tokens', {
    method: 'POST',
    body: JSON.stringify({ days: 1, purpose: 'native-mcp-integration' }),
  });
  assert.ok(issued.token);
  const claims = JSON.parse(Buffer.from(issued.token.split('.')[1], 'base64url').toString('utf8'));
  assert.equal(claims.exp, undefined, '新签发的 JWT 不应包含 exp');
  assert.equal(issued.record.purpose, 'native-mcp-integration');
  assert.equal(issued.record.expiresAt, '');
  assert.equal(issued.record.status, 'active');
  assert.equal(issued.record.token, undefined);
  assert.equal(issued.record.tokenHash, undefined);

  const client = new Client({ name: 'cubebuddy-real-server-test', version: '1.0.0' });
  const endpoint = new URL('/mcp/test-agent', fixture.endpoint);
  await client.connect(new StreamableHTTPClientTransport(endpoint, {
    authProvider: { token: async () => issued.token },
  }));
  const listed = await client.listTools();
  assert.equal(listed.tools.length, 6);
  await client.close();

  const persisted = JSON.parse(await readFile(path.join(fixture.deployDir, 'jwt-token-registry.json'), 'utf8'));
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].token, undefined);
  assert.match(persisted[0].tokenHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(persisted).includes(issued.token), false);

  await adminRequest(fixture.endpoint, `/api/jwt/tokens/${encodeURIComponent(issued.record.id)}`, { method: 'DELETE' });

  const revokedClient = new Client({ name: 'cubebuddy-revoked-token-test', version: '1.0.0' });
  await assert.rejects(
    revokedClient.connect(new StreamableHTTPClientTransport(endpoint, {
      authProvider: { token: async () => issued.token },
    })),
    /401|Unauthorized|invalid|revoked/i,
  );
  await revokedClient.close().catch(() => {});
});

test('startup migrates legacy plaintext token records but rejects tokens without an explicit Server', async (t) => {
  const legacyToken = jwtlib.sign({ secret: JWT_SECRET, days: 1, context: { service: true, purpose: 'legacy' } });
  const fixture = await startCubeBuddy(async (deployDir) => {
    await writeFile(path.join(deployDir, 'jwt-token-registry.json'), JSON.stringify([{
      id: 'legacy-token-record',
      token: legacyToken,
      purpose: 'legacy',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      days: 1,
    }]));
  });
  t.after(() => fixture.close());

  const migrated = JSON.parse(await readFile(path.join(fixture.deployDir, 'jwt-token-registry.json'), 'utf8'));
  assert.equal(migrated[0].token, undefined);
  assert.match(migrated[0].tokenHash, /^[a-f0-9]{64}$/);

  const client = new Client({ name: 'cubebuddy-legacy-token-test', version: '1.0.0' });
  await assert.rejects(
    client.connect(new StreamableHTTPClientTransport(new URL('/mcp/any-server', fixture.endpoint), {
      authProvider: { token: async () => legacyToken },
    })),
    /404|MCP Server|JWT|Unauthorized/i,
  );
  await client.close().catch(() => {});
});

test('MCP Server keys are bound to their own endpoint', async (t) => {
  const fixture = await startCubeBuddy(async (deployDir) => {
    await mkdir(path.join(deployDir, 'schema'), { recursive: true });
    await writeFile(path.join(deployDir, 'schema', 'orders.yml'), 'cubes:\n  - name: orders\n');
    await writeFile(path.join(deployDir, 'schema', 'finance.yml'), 'cubes:\n  - name: finance\n');
  });
  t.after(() => fixture.close());

  const listed = await adminRequest(fixture.endpoint, '/api/mcp-servers');
  assert.deepEqual(listed.servers, []);

  const created = await adminRequest(fixture.endpoint, '/api/mcp-servers', {
    method: 'POST',
    body: JSON.stringify({ id: 'sales-agent', name: '销售分析', modelIds: ['orders'] }),
  });
  assert.equal(created.server.id, 'sales-agent');

  const issued = await adminRequest(fixture.endpoint, '/api/mcp-servers/sales-agent/tokens', {
    method: 'POST', body: JSON.stringify({ purpose: 'sales-test' }),
  });
  assert.equal(issued.record.mcpServerId, 'sales-agent');

  const salesEndpoint = new URL('/mcp/sales-agent', fixture.endpoint);
  const client = new Client({ name: 'mcp-server-scope-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(salesEndpoint, { authProvider: { token: async () => issued.token } }));
  assert.equal((await client.listTools()).tools.length, 6);
  await client.close();

  const wrongClient = new Client({ name: 'mcp-server-wrong-endpoint-test', version: '1.0.0' });
  await assert.rejects(
    wrongClient.connect(new StreamableHTTPClientTransport(fixture.endpoint, { authProvider: { token: async () => issued.token } })),
    /404|serverId|Unauthorized|invalid|JWT/i,
  );
  await wrongClient.close().catch(() => {});
});

test('MCP requires an explicit Server endpoint and rejects the legacy default alias', async (t) => {
  const fixture = await startCubeBuddy(async (dir) => {
    await mkdir(path.join(dir, 'schema'), { recursive: true });
    await writeFile(path.join(dir, 'schema', 'orders.yml'), 'cubes:\n - name: orders\n');
  });
  t.after(() => fixture.close());
  const empty = await fetch(fixture.endpoint);
  assert.equal(empty.status, 404);
  assert.match((await empty.json()).error, /serverId/);
  const removedResponse = await fetch(new URL('/api/jwt', fixture.endpoint), { method: 'POST', headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(removedResponse.status, 410);
  assert.equal((await removedResponse.json()).error.includes('默认 MCP Server 已取消'), true);
  await adminRequest(fixture.endpoint, '/api/mcp-servers', { method: 'POST', body: JSON.stringify({ id: 'sales', modelIds: ['orders'] }) });
  const issued = await adminRequest(fixture.endpoint, '/api/mcp-servers/sales/tokens', { method: 'POST', body: '{}' });
  assert.equal(issued.record.mcpServerId, 'sales');
  const client = new Client({ name: 'explicit-endpoint-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp/sales', fixture.endpoint), { authProvider: { token: async () => issued.token } }));
  assert.equal((await client.listTools()).tools.length, 6);
  await client.close();
});

test('model transfer APIs require admin and save imported models as drafts', async (t) => {
  const fixture = await startCubeBuddy();
  t.after(() => fixture.close());
  assert.equal((await fetch(new URL('/api/model-transfer/catalog', fixture.endpoint))).status, 401);
  const upload = { name: 'orders.yml', data: Buffer.from('cubes:\n - name: orders\n').toString('base64') };
  const preview = await adminRequest(fixture.endpoint, '/api/model-transfer/preview', { method: 'POST', body: JSON.stringify({ upload }) });
  const result = await adminRequest(fixture.endpoint, '/api/model-transfer/import', { method: 'POST', body: JSON.stringify({ upload, mode: 'merge', revision: preview.revision }) });
  assert.equal(result.imported, 1);
  assert.deepEqual((await adminRequest(fixture.endpoint, '/api/model-transfer/catalog')).entries.map(item => item.id), ['orders']);
  const state = JSON.parse(await readFile(path.join(fixture.deployDir, '.cube-console-state.json'), 'utf8'));
  assert.deepEqual(state.pendingModels, ['orders.yml']);
});

test('model deletion requires explicit MCP detach confirmation', async (t) => {
  const fixture = await startCubeBuddy(async (dir) => {
    await mkdir(path.join(dir, 'schema'), { recursive: true });
    await writeFile(path.join(dir, 'schema', 'orders.yml'), 'cubes:\n - name: orders\n');
  });
  t.after(() => fixture.close());
  await adminRequest(fixture.endpoint, '/api/mcp-servers', {
    method: 'POST', body: JSON.stringify({ id: 'orders-agent', modelIds: ['orders'] }),
  });
  const bindings = await adminRequest(fixture.endpoint, '/api/models/orders.yml/mcp-bindings');
  assert.deepEqual(bindings.modelIds, ['orders']);
  assert.deepEqual(bindings.servers.map(item => item.id), ['orders-agent']);
  const response = await fetch(new URL('/api/models/orders.yml', fixture.endpoint), {
    method: 'DELETE', headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' }, body: '{}',
  });
  const blocked = await response.json();
  assert.equal(response.status, 409);
  assert.match(blocked.error, /解除绑定/);
  assert.equal((await adminRequest(fixture.endpoint, '/api/mcp-servers/orders-agent')).server.modelIds[0], 'orders');
  assert.match(await readFile(path.join(fixture.deployDir, 'schema', 'orders.yml'), 'utf8'), /orders/);
});
