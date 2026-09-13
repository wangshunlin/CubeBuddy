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
  const fixture = await startCubeBuddy();
  t.after(() => fixture.close());

  const issued = await adminRequest(fixture.endpoint, '/api/jwt', {
    method: 'POST',
    body: JSON.stringify({ days: 1, purpose: 'native-mcp-integration' }),
  });
  assert.ok(issued.token);
  assert.equal(issued.record.purpose, 'native-mcp-integration');
  assert.equal(issued.record.token, undefined);
  assert.equal(issued.record.tokenHash, undefined);

  const client = new Client({ name: 'cubebuddy-real-server-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(fixture.endpoint, {
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
    revokedClient.connect(new StreamableHTTPClientTransport(fixture.endpoint, {
      authProvider: { token: async () => issued.token },
    })),
    /401|Unauthorized|invalid|revoked/i,
  );
  await revokedClient.close().catch(() => {});
});

test('startup migrates legacy plaintext token records without invalidating them', async (t) => {
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
  await client.connect(new StreamableHTTPClientTransport(fixture.endpoint, {
    authProvider: { token: async () => legacyToken },
  }));
  assert.equal((await client.listTools()).tools.length, 6);
  await client.close();
});

test('MCP Server keys are bound to their own endpoint', async (t) => {
  const fixture = await startCubeBuddy(async (deployDir) => {
    await mkdir(path.join(deployDir, 'schema'), { recursive: true });
    await writeFile(path.join(deployDir, 'schema', 'orders.yml'), 'cubes:\n  - name: orders\n');
    await writeFile(path.join(deployDir, 'schema', 'finance.yml'), 'cubes:\n  - name: finance\n');
  });
  t.after(() => fixture.close());

  const listed = await adminRequest(fixture.endpoint, '/api/mcp-servers');
  assert.equal(listed.servers[0].id, 'default');
  assert.deepEqual(listed.servers[0].modelIds, ['finance', 'orders']);

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
    /401|Unauthorized|invalid|JWT/i,
  );
  await wrongClient.close().catch(() => {});
});
