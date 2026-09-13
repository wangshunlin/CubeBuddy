import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const valueOf = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const manifestPath = valueOf('--manifest');
const container = valueOf('--container', 'cube-console-cube_console-1');
const gatewayContainer = valueOf('--gateway-container', 'cube-console-cube_gateway-1');
const revision = valueOf('--revision');
const consolePort = Number(valueOf('--console-port', '18181'));
const cubePort = Number(valueOf('--cube-port', '18180'));
const statePath = valueOf('--glossary-state', '/opt/cube-console/state/glossary/glossary.json');

if (!manifestPath || !revision) {
  console.error('缺少 --manifest 或 --revision');
  process.exit(2);
}

const checks = [];
const check = async (name, callback) => {
  try {
    const details = await callback();
    checks.push({ name, ok: true, details });
    console.log(`PASS ${name}${details ? ` - ${details}` : ''}`);
  } catch (error) {
    checks.push({ name, ok: false, error: String(error.message || error) });
    console.error(`FAIL ${name} - ${String(error.message || error)}`);
  }
};

const docker = (...commandArgs) => execFileSync('docker', commandArgs, { encoding: 'utf8' }).trim();
const fetchStatus = async (url, expected) => {
  const response = await fetch(url, { redirect: 'manual' });
  if (!expected.includes(response.status)) throw new Error(`${url} 返回 ${response.status}`);
  return String(response.status);
};

await check('容器健康状态', async () => {
  const status = docker('inspect', '-f', '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}', container);
  if (status !== 'healthy') throw new Error(status);
  return status;
});

await check('网关容器健康状态', async () => {
  const status = docker('inspect', '-f', '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}', gatewayContainer);
  if (status !== 'healthy') throw new Error(status);
  return status;
});

await check('镜像 Git revision 标签', async () => {
  const actual = docker('inspect', '-f', '{{index .Config.Labels "org.opencontainers.image.revision"}}', container);
  if (actual !== revision) throw new Error(`期望 ${revision}，实际 ${actual || '空'}`);
  return actual.slice(0, 12);
});

await check('网关镜像 Git revision 标签', async () => {
  const actual = docker('inspect', '-f', '{{index .Config.Labels "org.opencontainers.image.revision"}}', gatewayContainer);
  if (actual !== revision) throw new Error(`期望 ${revision}，实际 ${actual || '空'}`);
  return actual.slice(0, 12);
});

await check('容器文件与发布清单一致', async () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const relative of manifest.containerFiles || []) {
    const expected = manifest.files?.[relative]?.sha256;
    if (!expected) throw new Error(`清单缺少 ${relative}`);
    const content = execFileSync('docker', ['exec', container, 'cat', `/app/${relative}`]);
    const actual = crypto.createHash('sha256').update(content).digest('hex');
    if (actual !== expected) throw new Error(`${relative} hash 不一致`);
  }
  return `${manifest.containerFiles.length} 个文件`;
});

await check('原生 MCP 构建产物', async () => {
  docker('exec', container, 'test', '-s', '/app/dist/mcp/index.js');
  const marker = docker('exec', container, 'sh', '-c', 'grep -c "CubeBuddy 原生 MCP" /app/server/server.js');
  if (Number(marker) < 1) throw new Error('server.js 缺少 /mcp 路由');
  return 'route + dist';
});

await check('配置台健康检查', () => fetchStatus(`http://127.0.0.1:${consolePort}/healthz`, [200]));
await check('Cube 就绪检查', () => fetchStatus(`http://127.0.0.1:${cubePort}/readyz`, [200]));
await check('MCP 未鉴权检查', () => fetchStatus(`http://127.0.0.1:${cubePort}/mcp`, [401]));

await check('MCP Server 动态路由检查', async () => {
  const response = await fetch(`http://127.0.0.1:${cubePort}/mcp/release-route-check`, { redirect: 'manual' });
  const contentType = response.headers.get('content-type') || '';
  const payload = await response.json().catch(() => null);
  if (response.status !== 404 || !contentType.includes('application/json') || !String(payload?.error || '').includes('MCP Server')) {
    throw new Error(`动态路由未到达控制台：status=${response.status}, content-type=${contentType || '空'}`);
  }
  return 'JSON 404 from cube_console';
});

await check('业务术语描述持久化', async () => {
  const payload = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const items = Array.isArray(payload) ? payload : payload.items || [];
  const described = items.filter((item) => String(item?.description || '').trim()).length;
  if (!items.length || described !== items.length) throw new Error(`${described}/${items.length} 条有描述`);
  return `${described}/${items.length}`;
});

await check('前端关键功能标记', async () => {
  const app = await (await fetch(`http://127.0.0.1:${consolePort}/app.js`, { cache: 'no-store' })).text();
  const css = await (await fetch(`http://127.0.0.1:${consolePort}/styles/typography.css`, { cache: 'no-store' })).text();
  for (const [name, content, markers] of [
    ['app.js', app, ['glossary-page-search', 'glossary-table', 'nativeMcp', 'item.description', 'realApi']],
    ['typography.css', css, ['position: sticky', 'glossary-table']],
  ]) {
    for (const marker of markers) if (!content.includes(marker)) throw new Error(`${name} 缺少 ${marker}`);
  }
  return 'single runtime + MCP + glossary UI';
});

if (checks.some((item) => !item.ok)) process.exit(1);
console.log(`验收完成：${checks.length} 项全部通过`);
