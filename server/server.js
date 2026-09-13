'use strict';
// ============================================================
// Cube 配置 UI — 零依赖 Node 服务
// 管理 /opt/cube-deploy 下的 .env（数据源）与 schema/*.yml（建模），
// 提供 JWT / OpenAPI 导出，可触发 docker compose 重建 Cube。
// 部署：systemd 宿主进程（见 cube-config-ui.service）
// ============================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const YAML = require('yaml');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const DEPLOY_DIR = process.env.CUBE_DEPLOY_DIR || '/opt/cube-deploy';
const OPENAPI_PATH = process.env.CUBE_OPENAPI_PATH || path.join(DEPLOY_DIR, 'openapi', 'openapi.yaml');
const ADMIN_TOKEN = process.env.CUBE_UI_ADMIN_TOKEN || '';
const API_BASE = process.env.CUBE_API_BASE || 'http://127.0.0.1:4002';
const PORT = parseInt(process.env.PORT || '4003', 10);
const HOST = process.env.HOST || '0.0.0.0';

const envfile = require('./lib/envfile');
const models = require('./lib/models');
const jwtlib = require('./lib/jwt');
const runx = require('./lib/run');
const dbx = require('./lib/db');
const glos = require('./lib/glossary');
const dsx = require('./lib/datasources');
const { createCubeTools } = require('./lib/cube-tools');
const mcpServers = require('./lib/mcp-servers');
const { createNativeMcp } = require('../dist/mcp');

const ENV_PATH = path.join(DEPLOY_DIR, '.env');
const SETTINGS_PATH = path.join(DEPLOY_DIR, 'console-settings.json');
const CONSOLE_STATE_PATH = path.join(DEPLOY_DIR, '.cube-console-state.json');
const TOKEN_REGISTRY_PATH = path.join(DEPLOY_DIR, 'jwt-token-registry.json');
const nativeMcpCache = new Map();
const modelApplyJobs = new Map();
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.yaml': 'application/yaml; charset=utf-8',
  '.yml': 'application/yaml; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

function readStaticOpenApi() {
  if (!fs.existsSync(OPENAPI_PATH)) throw new Error('openapi.yaml 文件不存在');
  const content = fs.readFileSync(OPENAPI_PATH, 'utf8');
  const document = YAML.parseDocument(content);
  if (document.errors.length) throw new Error(document.errors.map((error) => error.message).join('; '));
  const spec = document.toJS();
  if (!spec || typeof spec !== 'object' || !/^3\./.test(String(spec.openapi || ''))) throw new Error('openapi.yaml 不是 OpenAPI 3.x 规范');
  if (!spec.info || typeof spec.info !== 'object' || !spec.paths || typeof spec.paths !== 'object') throw new Error('openapi.yaml 缺少 info 或 paths');
  return { content, spec };
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj, null, 2));
}

function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => {
      try { resolve(JSON.parse(d || '{}')); } catch (e) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

function openApiContent(content) {
  if (!content || typeof content !== 'object') return {};
  return Object.fromEntries(Object.entries(content).map(([mediaType, media]) => [mediaType, {
    ...(media && typeof media === 'object' ? media : {}),
  }]));
}

function openApiOperationDetails(pathItem, operation) {
  const pathParameters = Array.isArray(pathItem?.parameters) ? pathItem.parameters : [];
  const operationParameters = Array.isArray(operation?.parameters) ? operation.parameters : [];
  const parameters = [...pathParameters, ...operationParameters].map((parameter) => {
    if (!parameter || typeof parameter !== 'object') return parameter;
    if (parameter.$ref) return { $ref: parameter.$ref };
    return {
      name: parameter.name,
      in: parameter.in,
      required: parameter.required === true,
      ...(parameter.description ? { description: String(parameter.description) } : {}),
      ...(parameter.deprecated ? { deprecated: true } : {}),
      ...(parameter.style ? { style: parameter.style } : {}),
      ...(parameter.explode !== undefined ? { explode: parameter.explode } : {}),
      ...(parameter.schema ? { schema: parameter.schema } : {}),
      ...(parameter.example !== undefined ? { example: parameter.example } : {}),
      ...(parameter.examples ? { examples: parameter.examples } : {}),
    };
  });
  const requestBody = operation?.requestBody && typeof operation.requestBody === 'object' ? {
    ...(operation.requestBody.$ref ? { $ref: operation.requestBody.$ref } : {}),
    ...(operation.requestBody.description ? { description: String(operation.requestBody.description) } : {}),
    ...(operation.requestBody.required !== undefined ? { required: operation.requestBody.required === true } : {}),
    ...(operation.requestBody.content ? { content: openApiContent(operation.requestBody.content) } : {}),
  } : null;
  const responses = Object.fromEntries(Object.entries(operation?.responses || {}).map(([status, response]) => [status, {
    ...(response && typeof response === 'object' ? response : {}),
  }]));
  return {
    description: String(operation?.description || ''),
    parameters,
    requestBody,
    responses,
  };
}

// ---- 工具列表辅助：按 OpenAPI 结构解析源文件和扩展注册表 ----
function parseCubeCoreTools(sourceContent = '') {
  const p = OPENAPI_PATH;
  if (!fs.existsSync(p)) return [];
  const spec = YAML.parse(sourceContent || fs.readFileSync(p, 'utf8')) || {};
  const methods = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head']);
  return Object.entries(spec.paths || {}).flatMap(([toolPath, pathItem]) =>
    Object.entries(pathItem || {})
      .filter(([method, operation]) => methods.has(method.toLowerCase()) && operation && typeof operation === 'object' && operation.operationId)
      .map(([method, operation]) => {
        const details = openApiOperationDetails(pathItem, operation);
        const operationForPreview = JSON.parse(JSON.stringify(operation));
        if (typeof details.description === 'string') operationForPreview.description = details.description;
        if (details.requestBody && operationForPreview.requestBody) operationForPreview.requestBody = details.requestBody;
        const pathItemForPreview = {};
        ['summary', 'description', 'servers', 'parameters'].forEach((key) => {
          if (pathItem[key] !== undefined) pathItemForPreview[key] = pathItem[key];
        });
        pathItemForPreview[method.toLowerCase()] = operationForPreview;
        return {
          method: method.toUpperCase(),
          path: toolPath,
          name: String(operation.operationId),
          summary: String(operation.summary || operation.description || ''),
          description: details.description,
          parameters: details.parameters,
          requestBody: details.requestBody,
          responses: details.responses,
          // 由实际解析出的 path/method operation 生成，避免前端重新拼接出不完整的 YAML。
          operationYaml: YAML.stringify({ paths: { [toolPath]: pathItemForPreview } }),
        };
      }),
  );
}

function openApiSource() {
  const p = OPENAPI_PATH;
  if (!fs.existsSync(p)) throw new Error('openapi 文件不存在');
  const content = fs.readFileSync(p, 'utf8');
  const doc = YAML.parseDocument(content);
  if (doc.errors.length) throw new Error(doc.errors.map((error) => error.message).join('; '));
  const spec = doc.toJS();
  if (!spec || typeof spec !== 'object' || !/^3\./.test(String(spec.openapi || ''))) throw new Error('openapi.yaml 不是 OpenAPI 3.x 规范');
  if (!spec.info || typeof spec.info !== 'object' || !spec.paths || typeof spec.paths !== 'object') throw new Error('openapi.yaml 缺少 info 或 paths');
  const stat = fs.statSync(p);
  return {
    name: path.basename(p),
    content,
    size: Buffer.byteLength(content),
    mtime: stat.mtime.toISOString(),
    cubeCore: parseCubeCoreTools(content),
    spec,
  };
}

// ---- 工具列表辅助：从 anythingmcp 动态拉取 MCP 工具（SSE 解析） ----
async function fetchMcpTools() {
  const amcpBase = process.env.ANYTHINGMCP_PUBLIC_BASE || '';
  const serverId = process.env.AMCP_CUBE_SERVER_ID || '';
  const key = process.env.AMCP_CUBE_API_KEY || '';
  if (!amcpBase || !serverId || !key) return [];
  const url = amcpBase + '/mcp/' + serverId;
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'X-API-Key': key };
  await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'cube-admin-ui', version: '1.0' } } }),
  }).catch(() => {});
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) });
  const text = await response.text();
  const data = text.split('\n').filter((line) => line.trim().startsWith('data:')).map((line) => line.trim().slice(5).trim());
  const result = JSON.parse(data.join(''));
  return ((result.result && result.result.tools) || []).map((tool) => ({
    name: tool.name,
    description: String(tool.description || '').slice(0, 300),
    params: Object.keys((tool.inputSchema && tool.inputSchema.properties) || {}),
  }));
}

function authOk(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!ADMIN_TOKEN || !m) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(m[1]), Buffer.from(ADMIN_TOKEN));
  } catch (e) {
    return false;
  }
}

function envSecret() {
  const stateSecret = envfile.read(ENV_PATH).data.CUBEJS_API_SECRET;
  // Compose env_file 是 Cube 的实际运行时配置；首次部署时 state/.env 可能尚未生成。
  return stateSecret || process.env.CUBEJS_API_SECRET || '';
}

function composeEnvPath() {
  return String(process.env.CUBE_COMPOSE_ENV_PATH || '').trim();
}

// 配置台写入 state/.env 后，同步更新 Compose 使用的 env_file。
// 这样数据源/密钥修改不再需要人工复制两份 .env；未配置挂载时保持旧行为。
function syncComposeEnv(updates, { replaceDatasource = false } = {}) {
  const target = composeEnvPath();
  if (!target || path.resolve(target) === path.resolve(ENV_PATH) || !fs.existsSync(target)) return false;
  const parsed = envfile.read(target);
  try {
    fs.copyFileSync(target, target + '.bak');
  } catch (error) {
    // 生产 Compose 将项目目录以只读方式挂载到配置台；此时 .env 可以写入，
    // 但无法在同级创建 .bak。备份回退到可写的状态目录，不能因备份路径只读而阻断应用。
    const fallback = path.join(DEPLOY_DIR, '.compose-env.bak');
    try {
      fs.copyFileSync(target, fallback);
    } catch (fallbackError) {
      throw new Error(`Compose 环境文件备份失败：${fallbackError.message || error.message}`);
    }
  }
  const next = { ...parsed.data, ...updates };
  if (replaceDatasource) {
    Object.keys(next).forEach((key) => {
      if (key.startsWith('CUBEJS_DS_')) delete next[key];
    });
    Object.entries(updates).forEach(([key, value]) => {
      if (key.startsWith('CUBEJS_DS_')) next[key] = value;
    });
  }
  envfile.write(target, next);
  return true;
}

function updateStateEnv(updates) {
  const parsed = envfile.read(ENV_PATH);
  if (fs.existsSync(ENV_PATH)) fs.copyFileSync(ENV_PATH, ENV_PATH + '.bak');
  fs.mkdirSync(path.dirname(ENV_PATH), { recursive: true });
  fs.writeFileSync(ENV_PATH, envfile.update(parsed, updates), 'utf8');
  syncComposeEnv(updates);
}

function applyDatasources(options = {}) {
  const result = dsx.apply(DEPLOY_DIR, options);
  // dsx.buildEnv 已合并 Compose env 与 state env，完整同步后能清理旧的命名源变量。
  syncComposeEnv(dsx.buildEnv(DEPLOY_DIR), { replaceDatasource: true });
  return result;
}

// .env 由 Cube API 和刷新 Worker 在容器创建时注入；修改后只重建这两个服务，
// 不要对整个 Compose 项目执行 up，否则配置台自身可能被重建，导致当前 HTTP 请求被网关中断并返回 502。
async function recreateCubeRuntime() {
  const restart = await runx.compose(DEPLOY_DIR, [
    'up', '-d', '--no-build', '--force-recreate',
    'cube_api', 'cube_refresh_worker',
  ]);
  if (!restart.ok) {
    return {
      ok: false,
      restart,
      error: restart.stderr || restart.error || 'Cube API / Worker 重建失败',
    };
  }
  try {
    const loaded = await runx.waitForCube(API_BASE, envSecret());
    return { ok: true, restart, loaded };
  } catch (error) {
    return {
      ok: false,
      restart,
      error: `Cube 重建后未就绪：${error.message}`,
    };
  }
}

function cubeToolAuthOk(req) {
  const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  return !!match && jwtlib.verify(match[1], envSecret());
}

async function proxyCubeTool(req, res, url) {
  if (!cubeToolAuthOk(req)) return sendJson(res, 401, { ok: false, error: '未授权：需要 Cube API JWT' });
  try {
    const headers = { Accept: 'application/json' };
    if (req.headers.authorization) headers.Authorization = req.headers.authorization;
    let body;
    if (!['GET', 'HEAD'].includes(req.method)) {
      const payload = await readBody(req);
      body = JSON.stringify(payload);
      headers['Content-Type'] = 'application/json';
    }
    const target = API_BASE + url.pathname + url.search;
    const response = await fetch(target, { method: req.method, headers, body, signal: AbortSignal.timeout(60000) });
    const text = await response.text();
    res.writeHead(response.status, { 'Content-Type': response.headers.get('content-type') || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(text);
  } catch (error) {
    return sendJson(res, 502, { ok: false, error: String(error.message || error) });
  }
}

async function proxyCubeHealth(res, url) {
  try {
    const response = await fetch(API_BASE + url.pathname + url.search, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    const text = await response.text();
    res.writeHead(response.status, {
      'Content-Type': response.headers.get('content-type') || 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    return res.end(text);
  } catch (error) {
    return sendJson(res, 502, { ok: false, error: String(error.message || error) });
  }
}

// 原生 MCP 需要 Bearer JWT，健康检查不携带令牌时预期会返回 401；
// 这仍然证明 /mcp 路由存在。404 表示路由缺失，网络错误和 5xx 表示服务异常。
async function probeNativeMcp(endpoint) {
  const startedAt = Date.now();
  let probeEndpoint = endpoint;
  try {
    const parsed = new URL(endpoint);
    // 本地 Compose 的 CUBE_PUBLIC_BASE 通常是宿主机 127.0.0.1，
    // 配置台容器不能通过该地址访问宿主机网关，改探测同一网络内的 console 服务。
    if (['localhost', '127.0.0.1'].includes(parsed.hostname)) {
      probeEndpoint = `http://cube_console:4010${parsed.pathname}${parsed.search}`;
    }
  } catch (_) { /* 保留原始地址，让 fetch 返回受控失败状态 */ }
  try {
    const response = await fetch(probeEndpoint, {
      method: 'GET',
      headers: { Accept: 'application/json, text/event-stream' },
      signal: AbortSignal.timeout(3000),
    });
    const httpStatus = response.status;
    const healthy = httpStatus !== 404 && httpStatus < 500;
    return {
      healthy,
      httpStatus,
      durationMs: Date.now() - startedAt,
      message: httpStatus === 401 ? 'MCP 路由正常，需 Bearer JWT 鉴权' : (healthy ? 'MCP 路由可达' : 'MCP 服务异常'),
    };
  } catch (error) {
    return {
      healthy: false,
      httpStatus: 0,
      durationMs: Date.now() - startedAt,
      message: `MCP 探测失败：${String(error.message || error)}`,
    };
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function readTokenRegistry() {
  try {
    const value = JSON.parse(fs.readFileSync(TOKEN_REGISTRY_PATH, 'utf8'));
    return Array.isArray(value) ? value.map(normalizeTokenRecord).filter(Boolean) : [];
  } catch (_) {
    return [];
  }
}

function writeTokenRegistry(records) {
  fs.mkdirSync(path.dirname(TOKEN_REGISTRY_PATH), { recursive: true });
  const safeRecords = records.map(normalizeTokenRecord).filter(Boolean).slice(0, 100);
  fs.writeFileSync(TOKEN_REGISTRY_PATH, JSON.stringify(safeRecords, null, 2), { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(TOKEN_REGISTRY_PATH, 0o600); } catch (_) { /* best effort on non-Unix filesystems */ }
}

function tokenRecordView(record) {
  const expiresAt = Date.parse(record.expiresAt || '');
  const { tokenHash, ...safe } = normalizeTokenRecord(record) || {};
  return { ...safe, status: Number.isFinite(expiresAt) && expiresAt > Date.now() ? 'active' : 'expired' };
}

function normalizeTokenRecord(record) {
  if (!record || typeof record !== 'object' || !record.id) return null;
  const token = typeof record.token === 'string' ? record.token : '';
  const tokenHash = String(record.tokenHash || (token ? sha256(token) : ''));
  if (!tokenHash) return null;
  return {
    id: String(record.id),
    createdAt: String(record.createdAt || ''),
    expiresAt: String(record.expiresAt || ''),
    days: Number(record.days || 0),
    purpose: String(record.purpose || 'service-account'),
    prefix: String(record.prefix || (token ? `${token.slice(0, 18)}…` : '')),
    fingerprint: String(record.fingerprint || tokenHash.slice(0, 16)),
    tokenHash,
    ...(record.jti ? { jti: String(record.jti) } : {}),
    // 旧版密钥只允许继续访问兼容的 default MCP Server。
    mcpServerId: String(record.mcpServerId || 'default'),
  };
}

function createTokenRecord(token, days, context = {}) {
  const createdAt = Date.now();
  const id = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
  const tokenHash = sha256(token);
  const claims = jwtlib.verifyClaims(token, envSecret());
  return {
    id,
    createdAt: new Date(createdAt).toISOString(),
    expiresAt: new Date(createdAt + days * 86400000).toISOString(),
    days,
    purpose: String(context.purpose || 'service-account'),
    prefix: `${token.slice(0, 18)}…`,
    fingerprint: tokenHash.slice(0, 16),
    tokenHash,
    ...(claims?.jti ? { jti: String(claims.jti) } : {}),
    ...(claims?.p?.mcpServerId ? { mcpServerId: String(claims.p.mcpServerId) } : {}),
  };
}

function tokenRecordActive(token) {
  const tokenHash = sha256(token);
  const record = readTokenRegistry().find((item) => item.tokenHash === tokenHash);
  if (!record) return false;
  const expiresAt = Date.parse(record.expiresAt || '');
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

function migrateTokenRegistry() {
  if (!fs.existsSync(TOKEN_REGISTRY_PATH)) return;
  // 旧版本曾保存完整 JWT；启动时立即改写为摘要记录，旧令牌仍可继续使用和撤销。
  writeTokenRegistry(readTokenRegistry());
}

function csvValues(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function urlHostname(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  try { return new URL(text.includes('://') ? text : `http://${text}`).hostname; }
  catch (_) { return ''; }
}

function configuredHostnames(value) {
  return [...new Set(csvValues(value).map(urlHostname).filter(Boolean))];
}

function mcpAllowedHosts() {
  const configured = configuredHostnames(process.env.MCP_ALLOWED_HOSTS);
  if (configured.length) return configured;
  return [...new Set([
    'localhost', '127.0.0.1', '[::1]', 'cube_console',
    urlHostname(process.env.CUBE_PUBLIC_BASE),
    urlHostname(envfile.read(ENV_PATH).data.CUBE_PUBLIC_BASE),
  ].filter(Boolean))];
}

function mcpAllowedOrigins() {
  const configured = configuredHostnames(process.env.MCP_ALLOWED_ORIGINS);
  if (configured.length) return configured;
  const state = envfile.read(ENV_PATH).data;
  return [...new Set([
    ...mcpAllowedHosts(),
    urlHostname(process.env.CONSOLE_PUBLIC_BASE),
    urlHostname(state.CONSOLE_PUBLIC_BASE),
  ].filter(Boolean))];
}

function verifyMcpAccessToken(token, expectedServerId = 'default') {
  const claims = jwtlib.verifyClaims(token, envSecret());
  if (!claims) throw new Error('JWT 签名无效或已过期');
  if (!tokenRecordActive(token)) throw new Error('JWT 未登记或已撤销');
  const audiences = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
  if (audiences.length && !audiences.includes('cube-mcp')) throw new Error('JWT audience 不允许访问原生 MCP');
  const tokenServerId = String(claims.p?.mcpServerId || 'default');
  if (tokenServerId !== expectedServerId) throw new Error('JWT 不允许访问当前 MCP Server');
  const scopes = Array.isArray(claims.scope)
    ? claims.scope.map(String)
    : String(claims.scope || 'cube:read').split(/\s+/).filter(Boolean);
  return {
    token,
    clientId: String(claims.sub || claims.u || sha256(token).slice(0, 16)),
    scopes,
    expiresAt: Number(claims.exp),
    extra: {
      purpose: String(claims.p?.purpose || 'service-account'),
      ...(claims.jti ? { jti: String(claims.jti) } : {}),
    },
  };
}

const cubeTools = createCubeTools({
  apiBase: API_BASE,
  resolveGlossary: (text) => glos.resolveText(DEPLOY_DIR, text),
});

migrateTokenRegistry();

function availableMcpModelIds() {
  const ids = new Set();
  models.list(DEPLOY_DIR).forEach((model) => {
    try {
      const content = models.get(DEPLOY_DIR, model.name);
      const doc = YAML.parseDocument(content);
      const parsed = doc.errors.length ? null : doc.toJS();
      (parsed?.cubes || []).forEach((cube) => { if (cube?.name) ids.add(String(cube.name)); });
    } catch (_) { /* skip invalid model files */ }
  });
  return [...ids].sort();
}

function currentMcpServers() {
  return mcpServers.ensureDefault(DEPLOY_DIR, availableMcpModelIds()).servers;
}

function nativeMcpForServer(server) {
  const cacheKey = `${server.id}:${server.updatedAt}:${server.modelIds.join(',')}:${server.enabled}:${server.instructions}`;
  if (nativeMcpCache.has(cacheKey)) return nativeMcpCache.get(cacheKey);
  const nativeMcp = createNativeMcp({
    service: mcpServers.createScopedCubeToolService(cubeTools, server),
    verifyAccessToken: (token) => verifyMcpAccessToken(token, server.id),
    allowedHosts: mcpAllowedHosts(),
    allowedOrigins: mcpAllowedOrigins(),
    instructions: server.instructions,
    audit: (event) => console.log(JSON.stringify({ event: 'mcp.tool', mcpServerId: server.id, ...event })),
    onerror: (error) => console.error(`MCP handler error: ${error.message || error}`),
  });
  nativeMcpCache.set(cacheKey, nativeMcp);
  return nativeMcp;
}

function clearNativeMcpCache() {
  nativeMcpCache.clear();
}

function mcpServerById(id) {
  return currentMcpServers().find((item) => item.id === id) || null;
}

function mcpServerView(server) {
  const activeTokens = readTokenRegistry().filter((token) => token.mcpServerId === server.id && tokenRecordView(token).status === 'active').length;
  return { ...server, activeTokenCount: activeTokens };
}

function issueMcpToken(serverId, body = {}) {
  const server = mcpServerById(serverId);
  if (!server) throw new Error('MCP Server 不存在');
  if (!server.enabled) throw new Error('MCP Server 已停用，不能创建密钥');
  const days = Math.min(3650, Math.max(1, parseInt(body.days, 10) || 30));
  const secret = envSecret();
  if (!secret) throw new Error('CUBEJS_API_SECRET 缺失，先到「数据源」页确认');
  const purpose = String(body.purpose || body.context?.purpose || 'service-account').trim().slice(0, 80) || 'service-account';
  const context = { service: true, purpose, mcpServerId: server.id };
  const jwtId = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
  const token = jwtlib.sign({ secret, days, context, audience: 'cube-mcp', scopes: ['cube:read'], jwtId });
  const record = createTokenRecord(token, days, context);
  writeTokenRegistry([record, ...readTokenRegistry().filter((item) => item.id !== record.id)]);
  return { ok: true, token, days, record: tokenRecordView(record) };
}

function readSettings() {
  const defaults = {
    name: '生产环境',
    consoleDomain: '127.0.0.1',
    cubeApiUrl: API_BASE,
    deployPath: DEPLOY_DIR,
    timezone: 'Asia/Shanghai',
    imageRegistry: 'docker.io',
    offlineMode: true,
  };
  try { return { ...defaults, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) }; }
  catch (_) { return defaults; }
}

function readConsoleState() {
  try { return JSON.parse(fs.readFileSync(CONSOLE_STATE_PATH, 'utf8')); }
  catch (_) { return { pendingModels: [], loadedModels: [] }; }
}

function cubeNameKey(value) {
  return String(value || '').trim().replace(/\.ya?ml$/i, '');
}

function setModelPending(name, pending) {
  const state = readConsoleState();
  const names = new Set(Array.isArray(state.pendingModels) ? state.pendingModels : []);
  const loaded = new Set(Array.isArray(state.loadedModels) ? state.loadedModels.map(cubeNameKey) : []);
  if (pending) names.add(name); else names.delete(name);
  if (pending) loaded.delete(cubeNameKey(name));
  fs.writeFileSync(CONSOLE_STATE_PATH, JSON.stringify({ ...state, pendingModels: [...names].sort(), loadedModels: [...loaded].sort() }, null, 2), 'utf8');
}

function setLoadedModels(names) {
  const state = readConsoleState();
  const loadedModels = [...new Set((Array.isArray(names) ? names : []).map(cubeNameKey).filter(Boolean))].sort();
  fs.writeFileSync(CONSOLE_STATE_PATH, JSON.stringify({ ...state, loadedModels }, null, 2), 'utf8');
  return loadedModels;
}

let runtimeModelProbe = null;
async function ensureLoadedModels() {
  const state = readConsoleState();
  // Older state files do not have an authoritative runtime list. Migrate them
  // once from Cube's internal compiler; /meta is intentionally not used here
  // because it hides models with public: false.
  if (Object.prototype.hasOwnProperty.call(state, 'loadedModels')) {
    return [...new Set((state.loadedModels || []).map(cubeNameKey).filter(Boolean))];
  }
  if (!runtimeModelProbe) {
    runtimeModelProbe = runx.verifyCubeModels(DEPLOY_DIR, [])
      .then((result) => setLoadedModels(result.names || []))
      .catch(() => [])
      .finally(() => { runtimeModelProbe = null; });
  }
  return runtimeModelProbe;
}

function modelApplyJobView(job) {
  return {
    id: job.id,
    status: job.status,
    phase: job.phase || undefined,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    pending: job.pendingNames,
    error: job.error || undefined,
    applied: job.applied || undefined,
  };
}

async function runModelApplyJob(job) {
  try {
    job.phase = '重建 Cube 服务';
    job.updatedAt = new Date().toISOString();
    job.restart = await runx.compose(DEPLOY_DIR, ['up', '-d', '--no-build', '--force-recreate', '--remove-orphans', 'cube_api', 'cube_refresh_worker']);
    if (!job.restart.ok) throw new Error(job.restart.stderr || job.restart.error || 'Cube 重启失败');
    job.phase = '等待模型加载';
    job.updatedAt = new Date().toISOString();
    // 普通 /meta 会按对外可见性过滤模型，不能用它判断内部模型是否已加载。
    // 先确认服务健康，再在 Cube 容器内部编译当前模型目录并校验完整模型集合。
    job.loaded = await runx.waitForCube(API_BASE, envSecret(), 60000);
    job.phase = '校验模型编译';
    job.updatedAt = new Date().toISOString();
    job.compiled = await runx.verifyCubeModels(DEPLOY_DIR, job.expectedCubeNames);
    const loadedModels = setLoadedModels(job.compiled?.names || []);
    fs.writeFileSync(CONSOLE_STATE_PATH, JSON.stringify({ ...readConsoleState(), pendingModels: [], loadedModels }, null, 2), 'utf8');
    job.status = 'succeeded';
    job.phase = '已完成';
    job.applied = job.pendingNames;
  } catch (error) {
    job.status = 'failed';
    job.phase = '失败';
    job.error = error.message || '批量应用失败';
  }
  job.updatedAt = new Date().toISOString();
}

async function cubeRequest(pathname, body) {
  const secret = envSecret();
  if (!secret) throw new Error('CUBEJS_API_SECRET 缺失');
  const token = jwtlib.sign({ secret, days: 1, context: { service: true } });
  const startedAt = Date.now();
  const response = await fetch(API_BASE + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
  return { ok: response.ok, status: response.status, durationMs: Date.now() - startedAt, data };
}

// 数据源名 → ds 对象（无数据源时返回 null；有数据源但未指定名称时优先 default，否则取第一条）
function resolveDs(name) {
  const sources = dsx.read(DEPLOY_DIR);
  if (!sources.length) return null;
  const hit = sources.find((s) => s.name === String(name || 'default'));
  return hit || sources.find((s) => s.name === 'default') || sources[0] || {
    name: 'default', type: 'mysql', host: '', port: '', database: '', user: 'root', password: '', ssl: false, container: '',
  };
}

function serveStatic(res, pathname) {
  const p = pathname === '/' ? path.join(PUBLIC, 'index.html') : path.join(PUBLIC, pathname);
  const safe = p.startsWith(PUBLIC);
  if (!safe || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not Found');
  }
  const ext = path.extname(p).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store, must-revalidate' });
  fs.createReadStream(p).pipe(res);
}

async function handleApi(req, res, url) {
  const method = req.method;
  const seg = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const send = (code, obj) => sendJson(res, code, obj);

  // ---- 登录（无需鉴权）----
  if (seg[1] === 'login') {
    const body = await readBody(req);
    let ok = false;
    if (ADMIN_TOKEN && body.token) {
      try { ok = crypto.timingSafeEqual(Buffer.from(String(body.token)), Buffer.from(ADMIN_TOKEN)); } catch (e) { ok = false; }
    }
    return send(ok ? 200 : 401, ok ? { ok: true } : { ok: false, error: '令牌错误' });
  }

  // ---- 其余 /api/* 需鉴权 ----
  if (seg[0] !== 'api' || !authOk(req)) return send(401, { ok: false, error: '未授权' });

  const r1 = seg[1] || '';
  const r2 = seg[2] || '';
  const sub = seg.slice(1).join('/');

  // MCP Server 管理：每个 Server 绑定一组语义模型和独立 JWT。
  if (r1 === 'mcp-servers') {
    const serverId = decodeURIComponent(r2 || '');
    if (method === 'GET' && !serverId) {
      return send(200, { ok: true, servers: currentMcpServers().map(mcpServerView), availableModels: availableMcpModelIds() });
    }
    if (method === 'POST' && !serverId) {
      try {
        const body = await readBody(req);
        const server = mcpServers.create(DEPLOY_DIR, body, availableMcpModelIds());
        clearNativeMcpCache();
        return send(201, { ok: true, server: mcpServerView(server) });
      } catch (error) { return send(400, { ok: false, error: error.message }); }
    }
    if (!serverId) return send(404, { ok: false, error: 'MCP Server 不存在' });
    if (method === 'GET' && seg.length === 3) {
      const server = mcpServerById(serverId);
      return server ? send(200, { ok: true, server: mcpServerView(server) }) : send(404, { ok: false, error: 'MCP Server 不存在' });
    }
    if (method === 'PUT' && seg.length === 3) {
      try {
        const body = await readBody(req);
        const server = mcpServers.update(DEPLOY_DIR, serverId, body, availableMcpModelIds());
        clearNativeMcpCache();
        return send(200, { ok: true, server: mcpServerView(server) });
      } catch (error) { return send(400, { ok: false, error: error.message }); }
    }
    if (method === 'DELETE' && seg.length === 3) {
      try {
        const active = readTokenRegistry().filter((token) => token.mcpServerId === serverId && tokenRecordView(token).status === 'active');
        if (active.length) return send(409, { ok: false, error: `该 MCP Server 仍有 ${active.length} 个有效密钥，请先撤销` });
        mcpServers.remove(DEPLOY_DIR, serverId);
        clearNativeMcpCache();
        return send(200, { ok: true, deleted: serverId });
      } catch (error) { return send(400, { ok: false, error: error.message }); }
    }
    if (method === 'GET' && seg[3] === 'tokens') {
      if (!mcpServerById(serverId)) return send(404, { ok: false, error: 'MCP Server 不存在' });
      const tokens = readTokenRegistry().filter((token) => token.mcpServerId === serverId).map(tokenRecordView)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      return send(200, { ok: true, tokens });
    }
    if (method === 'POST' && seg[3] === 'tokens') {
      try { return send(200, issueMcpToken(serverId, await readBody(req))); }
      catch (error) { return send(400, { ok: false, error: error.message }); }
    }
    if (method === 'DELETE' && seg[3] === 'tokens' && seg[4]) {
      const tokenId = decodeURIComponent(seg[4]);
      const records = readTokenRegistry();
      const target = records.find((token) => token.id === tokenId && token.mcpServerId === serverId);
      if (!target) return send(404, { ok: false, error: '密钥不存在' });
      writeTokenRegistry(records.filter((token) => token.id !== tokenId));
      return send(200, { ok: true, deleted: tokenId });
    }
    return send(404, { ok: false, error: `接口不存在: ${sub}` });
  }

  // 状态总览
  if (method === 'GET' && sub === 'status') {
    const [ready, ps] = await Promise.all([runx.readyz(API_BASE), runx.composePs(DEPLOY_DIR)]);
    return send(200, { ok: true, ready, ps, deployDir: DEPLOY_DIR });
  }

  // 工具列表：cube core（OpenAPI 解析）+ MCP（anythingmcp 动态拉取，实时刷新）
  if (method === 'GET' && sub === 'tools') {
    try {
      const source = openApiSource();
      const cubeCore = source.cubeCore;
      const mcp = await fetchMcpTools();
      const amcpBase = process.env.ANYTHINGMCP_PUBLIC_BASE || '';
      const serverId = process.env.AMCP_CUBE_SERVER_ID || '';
      return send(200, {
        ok: true,
        updatedAt: new Date().toISOString(),
        cubeCore,
        openapiSchemas: source.spec.components?.schemas || {},
        mcp,
        mcpSource: amcpBase && serverId ? amcpBase + '/mcp/' + serverId : '',
      });
    } catch (e) {
      return send(500, { ok: false, error: String(e.message || e) });
    }
  }
  if (method === 'POST' && sub === 'tools/refresh') {
    try {
      const source = openApiSource();
      return send(200, {
        ok: true,
        updatedAt: new Date().toISOString(),
        source: { name: source.name, size: source.size, mtime: source.mtime },
        cubeCore: source.cubeCore,
        openapiSchemas: source.spec.components?.schemas || {},
      });
    } catch (e) {
      return send(400, { ok: false, error: String(e.message || e) });
    }
  }
  if (method === 'GET' && sub === 'openapi/source') {
    try {
      const source = openApiSource();
      return send(200, { ok: true, ...source });
    } catch (e) {
      return send(400, { ok: false, error: String(e.message || e) });
    }
  }
  if (method === 'POST' && sub === 'openapi/source') {
    const body = await readBody(req);
    try {
      const content = typeof body.content === 'string' ? body.content : '';
      if (!content.trim()) throw new Error('OpenAPI 内容为空');
      if (Buffer.byteLength(content, 'utf8') > 10 * 1024 * 1024) throw new Error('OpenAPI 文件不能超过 10 MB');
      const doc = YAML.parseDocument(content);
      if (doc.errors.length) throw new Error(doc.errors.map((error) => error.message).join('; '));
      const parsed = doc.toJS();
      if (!parsed || typeof parsed !== 'object' || !/^3\./.test(String(parsed.openapi || ''))) throw new Error('文件不是 OpenAPI 3.x 规范');
      if (!parsed.info || typeof parsed.info !== 'object' || !parsed.paths || typeof parsed.paths !== 'object') throw new Error('OpenAPI 缺少 info 或 paths');
      const openapiPath = OPENAPI_PATH;
      fs.mkdirSync(path.dirname(openapiPath), { recursive: true });
      if (fs.existsSync(openapiPath)) fs.copyFileSync(openapiPath, openapiPath + '.bak');
      fs.writeFileSync(openapiPath, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
      return send(200, { ok: true, name: path.basename(openapiPath), paths: Object.keys(parsed.paths).length, note: '最终 openapi.yaml 已导入，写入前已创建 .bak 备份' });
    } catch (e) {
      return send(400, { ok: false, error: String(e.message || e) });
    }
  }

  // .env 读取
  if (method === 'GET' && sub === 'env') {
    const { data } = envfile.read(ENV_PATH);
    return send(200, { ok: true, env: data });
  }

  // .env 更新（只合并传入的 key，保留其它行）
  if (method === 'PUT' && sub === 'env') {
    const body = await readBody(req);
    const updates = body.env || {};
    if (!Object.keys(updates).length) return send(400, { ok: false, error: 'env 为空' });
    updateStateEnv(updates);
    return send(200, { ok: true, note: '已写入 .env。点击「应用并重建」使 Cube 生效' });
  }

  // 环境设置（部署地址不作为运行时连接配置）
  if (method === 'GET' && sub === 'environment') {
    return send(200, { ok: true, environment: readSettings() });
  }
  if (method === 'PUT' && sub === 'environment') {
    const body = await readBody(req);
    const next = { ...readSettings(), ...(body.environment || {}) };
    if (!/^[a-z0-9.-]+$/i.test(String(next.consoleDomain || ''))) return send(400, { ok: false, error: '配置台域名格式不正确' });
    if (!/^https?:\/\//i.test(String(next.cubeApiUrl || ''))) return send(400, { ok: false, error: 'Cube API 地址格式不正确' });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2), 'utf8');
    return send(200, { ok: true, environment: next });
  }
  if (method === 'POST' && sub === 'environment/test') {
    const ready = await runx.readyz(API_BASE);
    return send(ready.status === 200 ? 200 : 502, { ok: ready.status === 200, ready, deployDirExists: fs.existsSync(DEPLOY_DIR) });
  }

  // 生成新 API 密钥（安全操作，写入 .env）
  if (method === 'POST' && sub === 'rotate-secret') {
    const newSecret = crypto.randomBytes(32).toString('hex');
    updateStateEnv({ CUBEJS_API_SECRET: newSecret });
    return send(200, { ok: true, secret: newSecret, note: '已更新 CUBEJS_API_SECRET，需「应用并重建」生效；已有 JWT 将全部失效' });
  }

  // 模型列表
  if (method === 'GET' && sub === 'models') {
    const state = readConsoleState();
    const pending = new Set(state.pendingModels || []);
    const loadedModels = await ensureLoadedModels();
    const loaded = new Set(loadedModels);
    return send(200, {
      ok: true,
      loadedModels,
      models: models.list(DEPLOY_DIR).map((model) => ({
        ...model,
        pending: pending.has(model.name),
        loaded: loaded.has(cubeNameKey(model.name)),
      })),
    });
  }

  // 将 Cube 当前未应用的草稿重新加入待应用队列，供前端执行失败后的重试。
  if (method === 'POST' && sub === 'models/retry') {
    const body = await readBody(req);
    const requested = [...new Set((Array.isArray(body.names) ? body.names : []).map(String).filter(Boolean))];
    const available = new Set(models.list(DEPLOY_DIR).map((model) => model.name));
    const invalid = requested.filter((name) => !available.has(name));
    if (invalid.length) return send(400, { ok: false, error: `模型文件不存在：${invalid.join('、')}`, invalid });
    requested.forEach((name) => setModelPending(name, true));
    return send(200, { ok: true, pending: requested, note: `已将 ${requested.length} 个模型加入待应用队列` });
  }

  if (method === 'GET' && sub === 'models/apply-status') {
    const id = String(url.searchParams.get('id') || '');
    const job = modelApplyJobs.get(id);
    if (!job) return send(404, { ok: false, error: '发布任务不存在或已过期' });
    return send(200, { ok: true, job: modelApplyJobView(job) });
  }

  // 一次性应用全部已保存模型：先统一校验，再只重载一次 Cube。
  // 与单模型保存接口分开，避免用户逐个点击应用导致 Cube 频繁重启。
  if (method === 'POST' && sub === 'models/apply') {
    const body = await readBody(req);
    const requestedNames = [...new Set((Array.isArray(body.names) ? body.names : []).map(String).filter(Boolean))];
    if (requestedNames.length) {
      const available = new Set(models.list(DEPLOY_DIR).map((model) => model.name));
      const invalid = requestedNames.filter((name) => !available.has(name));
      if (invalid.length) return send(400, { ok: false, error: `模型文件不存在：${invalid.join('、')}`, invalid });
      // 将所有未应用草稿纳入本次原子应用请求，失败时仍保留待应用状态。
      requestedNames.forEach((name) => setModelPending(name, true));
    }
    const pendingNames = [...new Set((readConsoleState().pendingModels || []).map(String))].filter(Boolean).sort();
    if (!pendingNames.length) return send(200, { ok: true, applied: [], pending: [], note: '暂无待应用模型' });
    try {
      const validationErrors = [];
      const expectedCubeNames = [];
      for (const name of pendingNames) {
        try {
          const content = models.get(DEPLOY_DIR, name);
          const doc = YAML.parseDocument(content);
          if (doc.errors.length) throw new Error(doc.errors.map((error) => error.message).join('; '));
          const parsed = doc.toJS();
          if (!parsed || !Array.isArray(parsed.cubes) || !parsed.cubes.length) throw new Error('YAML 缺少 cubes 模型定义');
          const cubeNames = parsed.cubes.map((cube) => String(cube?.name || '').trim()).filter(Boolean);
          if (cubeNames.length !== parsed.cubes.length) throw new Error('YAML 中存在缺少 name 的 Cube 模型');
          expectedCubeNames.push(...cubeNames);
        } catch (error) {
          validationErrors.push(`${name}：${error.message}`);
        }
      }
      if (validationErrors.length) {
        return send(400, { ok: false, error: `模型校验失败：${validationErrors.join('；')}`, validationErrors, pending: pendingNames });
      }
      const activeJob = [...modelApplyJobs.values()].find((job) => job.status === 'running');
      if (activeJob) return send(202, { ok: true, job: modelApplyJobView(activeJob), pending: pendingNames, note: '已有发布任务正在执行' });
      const id = `model-apply-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
      const job = {
        id,
        status: 'running',
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        pendingNames,
        expectedCubeNames,
      };
      modelApplyJobs.set(id, job);
      void runModelApplyJob(job);
      return send(202, { ok: true, job: modelApplyJobView(job), pending: pendingNames, note: `已启动后台发布 ${pendingNames.length} 个模型` });
    } catch (error) {
      return send(500, { ok: false, error: error.message || '批量应用失败', pending: pendingNames });
    }
  }

  // 新建模型模板
  if (method === 'POST' && sub === 'models') {
    const body = await readBody(req);
    const baseName = String(body.name || 'new_cube').replace(/\.ya?ml$/i, '').replace(/[^A-Za-z0-9_]/g, '_') || 'new_cube';
    const name = `${baseName}.yml`;
    fs.writeFileSync(path.join(DEPLOY_DIR, 'schema', name), models.createTemplate(baseName), 'utf8');
    setModelPending(name, true);
    return send(200, { ok: true, name, note: '模板已创建，请编辑 sql_table 与字段' });
  }

  // ============ 多数据源管理 ============
  // 列表（密码脱敏）
  if (method === 'GET' && sub === 'datasources') {
    const sources = dsx.read(DEPLOY_DIR).map((s) => dsx.mask(s));
    return send(200, { ok: true, sources });
  }
  // 新增/更新（同名覆盖；apply=true 时写 .env 并重启 Cube）
  if (method === 'POST' && sub === 'datasources') {
    const body = await readBody(req);
    try {
      const r = dsx.upsert(DEPLOY_DIR, body);
      if (body.apply) {
        applyDatasources();
        const runtime = await recreateCubeRuntime();
        if (!runtime.ok) return send(503, { ok: false, ...r, applied: false, ...runtime });
      }
      return send(200, { ok: true, ...r, applied: !!body.apply });
    } catch (e) { return send(400, { ok: false, error: e.message }); }
  }
  // 删除（default 不可删）
  if (method === 'DELETE' && sub === 'datasources') {
    try {
      const r = dsx.remove(DEPLOY_DIR, url.searchParams.get('name'));
      return send(200, { ok: true, ...r });
    } catch (e) { return send(400, { ok: false, error: e.message }); }
  }
  // 应用全部数据源到 .env 并重建 Cube
  if (method === 'POST' && sub === 'datasources/apply') {
    try {
      const body = await readBody(req);
      const r = applyDatasources({ allowEmpty: body.allowEmpty === true });
      const runtime = await recreateCubeRuntime();
      if (!runtime.ok) return send(503, { ok: false, ...r, applied: false, ...runtime });
      return send(200, { ok: true, ...r, applied: true, restart: runtime.restart, loaded: runtime.loaded, note: '已写入 .env，Cube API 与 Worker 已恢复就绪' });
    } catch (e) { return send(400, { ok: false, error: e.message }); }
  }
  if (method === 'POST' && sub === 'datasources/test') {
    const body = await readBody(req);
    try {
      const startedAt = Date.now();
      const ds = resolveDs(body.name);
      if (!ds) return send(400, { ok: false, error: '当前没有数据源，请先新增数据源' });
      const databases = await dbx.listDatabases(ds);
      return send(200, { ok: true, datasource: ds.name, durationMs: Date.now() - startedAt, databases: databases.length });
    } catch (e) { return send(400, { ok: false, error: e.message }); }
  }

  // 数据库清单（跨库建模用；?ds=数据源名，缺省 default）
  if (method === 'GET' && sub === 'db/databases') {
    try {
      const ds = resolveDs(url.searchParams.get('ds'));
      if (!ds) return send(400, { ok: false, error: '当前没有数据源，请先新增数据源' });
      const dbs = await dbx.listDatabases(ds);
      return send(200, { ok: true, datasource: ds.name, databases: dbs });
    } catch (e) {
      return send(500, { ok: false, error: e.message });
    }
  }

  // 表清单（支持跨库：?db=库1&db=库2&ds=数据源；缺省用数据源默认库）
  if (method === 'GET' && sub === 'db/tables') {
    try {
      const ds = resolveDs(url.searchParams.get('ds'));
      if (!ds) return send(400, { ok: false, error: '当前没有数据源，请先新增数据源' });
      const dbs = url.searchParams.getAll('db').filter(Boolean);
      const tables = await dbx.listTables(ds, dbs);
      return send(200, { ok: true, datasource: ds.name, tables });
    } catch (e) {
      return send(500, { ok: false, error: e.message });
    }
  }

  // 自动建模：支持单表 {db, table, ds, save} 与批量 {items:[{db,table}...], ds, save}
  if (method === 'POST' && sub === 'db/generate') {
    const body = await readBody(req);
    try {
      const ds = resolveDs(body.ds || 'default');
      if (!ds) return send(400, { ok: false, error: '当前没有数据源，请先新增数据源' });
      const items = Array.isArray(body.items)
        ? body.items
        : [{ db: body.db || ds.database, table: body.table }];
      if (!items.length) return send(400, { ok: false, error: 'items 为空' });

      const results = [];
      let failed = null;
      for (const it of items) {
        try {
          // 生成器只返回 Cube 标准 YAML；禁止把官方 Playground 的
          // /playground/generate-schema 暴露或转发到这里，因为它会清理
          // cubes/views 目录。文件落盘统一走 putGenerated 的安全合并流程。
          const yaml = await dbx.generateModel(ds, it.db, it.table);
          if (body.save) {
            const name = it.table + '.yml';
            const r = models.putGenerated(DEPLOY_DIR, name, yaml);
            // 自动建模只生成草稿；必须由用户明确点击“应用到 Cube”后才重载运行时。
            setModelPending(name, true);
            results.push({ db: it.db, table: it.table, name, ok: true, generator: 'cube-official-scaffolding', ...r });
          } else {
            const name = it.table + '.yml';
            const existing = models.list(DEPLOY_DIR).some((model) => model.name === name);
            const preview = existing
              ? models.mergeGeneratedContent(models.get(DEPLOY_DIR, name), yaml)
              : null;
            results.push({
              db: it.db,
              table: it.table,
              name,
              ok: true,
              generator: 'cube-official-scaffolding',
              content: yaml,
              ...(preview ? {
                mergedContent: preview.content,
                addedCubes: preview.addedCubes,
                addedDimensions: preview.addedDimensions,
                preservedDimensions: preview.preservedDimensions,
                removedDimensions: preview.removedDimensions,
                updatedDimensions: preview.updatedDimensions,
              } : {}),
            });
          }
        } catch (e) {
          results.push({ db: it.db, table: it.table, ok: false, error: e.message });
          failed = failed || e.message;
        }
      }

      return send(failed ? 207 : 200, {
        ok: !failed,
        datasource: ds.name,
        results,
        failed,
        note: failed
          ? '部分失败：' + failed
          : `已生成 ${results.length} 个模型草稿，等待用户应用到 Cube；字段结构按数据库同步，语义配置已安全保留`,
      });
    } catch (e) {
      return send(400, { ok: false, error: e.message });
    }
  }

  // 结构化模型文档：完整 JSON 往返，未知 YAML 字段不会丢失
  if (method === 'GET' && sub === 'model-doc') {
    try {
      const name = String(url.searchParams.get('name') || '');
      const content = models.get(DEPLOY_DIR, name);
      const doc = YAML.parseDocument(content);
      if (doc.errors.length) throw new Error(doc.errors.map((error) => error.message).join('; '));
      return send(200, { ok: true, name, content, document: doc.toJS() });
    } catch (e) { return send(400, { ok: false, error: e.message }); }
  }
  if (method === 'PUT' && sub === 'model-doc') {
    const body = await readBody(req);
    try {
      const name = String(body.name || '');
      const content = typeof body.content === 'string' ? body.content : YAML.stringify(body.document || {});
      const doc = YAML.parseDocument(content);
      if (doc.errors.length) throw new Error(doc.errors.map((error) => error.message).join('; '));
      const parsed = doc.toJS();
      if (!parsed || !Array.isArray(parsed.cubes) || !parsed.cubes.length) throw new Error('YAML 缺少 cubes 模型定义');
      const expectedCubeNames = parsed.cubes.map((cube) => String(cube?.name || '').trim()).filter(Boolean);
      if (expectedCubeNames.length !== parsed.cubes.length) throw new Error('YAML 中存在缺少 name 的 Cube 模型');
      const currentModels = models.list(DEPLOY_DIR);
      if (currentModels.some((model) => model.name === name)) {
        const currentContent = models.get(DEPLOY_DIR, name);
        // YAML 是唯一事实源，但数据库字段结构不是表单可编辑项。
        // 自动建模的 putGenerated 不走此限制，负责在数据源变更后同步结构。
        models.assertDimensionStructureUnchanged(currentContent, content);
      }
      const saved = models.put(DEPLOY_DIR, name, content);
      let restart = null;
      let loaded = null;
      let compiled = null;
      let applyError = '';
      if (body.apply) {
        restart = await runx.compose(DEPLOY_DIR, ['up', '-d', '--no-build', '--force-recreate', '--remove-orphans', 'cube_api', 'cube_refresh_worker']);
        if (!restart.ok) applyError = restart.stderr || restart.error || 'Cube 重启失败';
        else {
          try {
            // /meta 会按 public 过滤模型，不能用它判断 public:false 的模型是否已加载。
            // 这里只用 /readyz 确认服务健康，再在 Cube 容器内部编译完整模型目录。
            loaded = await runx.waitForCube(API_BASE, envSecret(), 60000);
            compiled = await runx.verifyCubeModels(DEPLOY_DIR, expectedCubeNames);
          }
          catch (e) { applyError = e.message; }
        }
      }
      const pending = body.apply ? !!applyError : true;
      if (!applyError && body.apply) setLoadedModels(compiled?.names || expectedCubeNames);
      setModelPending(name, pending);
      return send(applyError ? 503 : 200, { ok: !applyError, saved, restart, loaded, compiled, pending, error: applyError || undefined });
    } catch (e) { return send(400, { ok: false, error: e.message }); }
  }
  if (method === 'POST' && sub === 'model-doc/validate') {
    const body = await readBody(req);
    try {
      const doc = YAML.parseDocument(String(body.content || ''));
      if (doc.errors.length) throw new Error(doc.errors.map((error) => error.message).join('; '));
      const parsed = doc.toJS();
      if (!parsed || !Array.isArray(parsed.cubes) || !parsed.cubes.length) throw new Error('YAML 缺少 cubes 模型定义');
      return send(200, { ok: true, formatted: String(doc), cubes: parsed.cubes.map((cube) => cube.name) });
    } catch (e) { return send(400, { ok: false, error: e.message }); }
  }

  // 读取单个模型
  if (method === 'GET' && sub.startsWith('models/')) {
    try {
      const content = models.get(DEPLOY_DIR, r2);
      return send(200, { ok: true, content });
    } catch (e) {
      return send(400, { ok: false, error: e.message });
    }
  }

  // 保存单个模型
  if (method === 'PUT' && sub.startsWith('models/')) {
    const body = await readBody(req);
    try {
      const currentModels = models.list(DEPLOY_DIR);
      if (currentModels.some((model) => model.name === r2)) {
        const currentContent = models.get(DEPLOY_DIR, r2);
        // 兼容旧接口也必须遵守同一条数据源字段保护规则，避免绕过
        // /api/model-doc 直接删除、改名或改写数据库字段结构。
        models.assertDimensionStructureUnchanged(currentContent, body.content);
      }
      const r = models.put(DEPLOY_DIR, r2, body.content);
      return send(200, { ok: true, ...r });
    } catch (e) {
      return send(400, { ok: false, error: e.message });
    }
  }

  // 删除单个模型（mv 到 schema/.trash/ 可恢复 + 自动重启 Cube）
  if (method === 'DELETE' && sub.startsWith('models/')) {
    try {
      const r = models.trash(DEPLOY_DIR, r2);
      const rr = await runx.compose(DEPLOY_DIR, ['up', '-d', '--no-build', '--force-recreate', '--remove-orphans', 'cube_api', 'cube_refresh_worker']);
      if (!rr.ok) {
        // Cube 重建失败时回滚文件移动，避免接口报错但模型已经消失，导致前端再次删除时报“文件不存在”。
        try { fs.renameSync(path.join(DEPLOY_DIR, r.trashed), path.join(DEPLOY_DIR, 'schema', r2)); } catch (_) { /* 保留原始错误 */ }
        return send(500, { ok: false, error: rr.error || rr.stderr || 'Cube 重启失败', restored: fs.existsSync(path.join(DEPLOY_DIR, 'schema', r2)) });
      }
      let loaded = null;
      let warning = '';
      try { loaded = await runx.waitForCube(API_BASE, envSecret(), 60000); }
      catch (error) { warning = `模型已删除，但 Cube 仍在恢复：${error.message}`; }
      setModelPending(r2, false);
      return send(200, {
        ok: true,
        trashed: r.trashed,
        restart: 'ok',
        loaded,
        warning: warning || undefined,
      });
    } catch (e) {
      return send(400, { ok: false, error: e.message });
    }
  }

  // 校验模型：调 Cube /meta 看 cube 是否已加载
  if (method === 'GET' && sub === 'meta') {
    try {
      const cubes = await runx.cubeMeta(API_BASE, envSecret());
      return send(200, { ok: true, cubes });
    } catch (e) {
      return send(502, { ok: false, error: e.message });
    }
  }

  // 测试查询抽屉：真实调用 Cube load / dry-run / sql
  if (method === 'POST' && sub === 'query') {
    const body = await readBody(req);
    if (!body.query || typeof body.query !== 'object') return send(400, { ok: false, error: 'query 必填' });
    try {
      const [load, sql] = await Promise.all([
        cubeRequest('/cubejs-api/v1/load', { query: body.query }),
        cubeRequest('/cubejs-api/v1/sql', { query: body.query }),
      ]);
      return send(load.ok ? 200 : load.status, { ok: load.ok, query: body.query, load, sql });
    } catch (e) { return send(502, { ok: false, error: e.message }); }
  }
  if (method === 'POST' && sub === 'query/dry-run') {
    const body = await readBody(req);
    if (!body.query || typeof body.query !== 'object') return send(400, { ok: false, error: 'query 必填' });
    try {
      const result = await cubeRequest('/cubejs-api/v1/dry-run', { query: body.query });
      return send(result.ok ? 200 : result.status, { ok: result.ok, query: body.query, result });
    } catch (e) { return send(502, { ok: false, error: e.message }); }
  }

  // cube_api 日志（排查模型编译错误）
  if (method === 'GET' && sub === 'logs') {
    const r = await runx.compose(DEPLOY_DIR, ['logs', '--no-color', '--tail', '120', 'cube_api']);
    return send(200, { ok: r.ok, stdout: r.stdout, stderr: r.stderr });
  }

  // 应用并重建 Cube（.env 变更需 recreate 才生效）
  if (method === 'POST' && sub === 'restart') {
    const runtime = await recreateCubeRuntime();
    return send(runtime.ok ? 200 : 503, runtime);
  }

  // 已签发 JWT 的记录（完整令牌只通过管理员鉴权接口返回）
  if (method === 'GET' && sub === 'jwt/tokens') {
    return send(200, { ok: true, tokens: readTokenRegistry().map(tokenRecordView).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))) });
  }

  if (method === 'DELETE' && sub.startsWith('jwt/tokens/')) {
    const id = decodeURIComponent(sub.slice('jwt/tokens/'.length));
    if (!id) return send(400, { ok: false, error: '令牌记录 ID 缺失' });
    const records = readTokenRegistry();
    const next = records.filter((record) => record.id !== id);
    if (next.length === records.length) return send(404, { ok: false, error: '令牌记录不存在' });
    writeTokenRegistry(next);
    return send(200, { ok: true, deleted: id });
  }

  // 签发服务 JWT（供 anythingmcp 鉴权）
  if (method === 'POST' && sub === 'jwt') {
    try {
      return send(200, issueMcpToken('default', await readBody(req)));
    } catch (e) {
      return send(400, { ok: false, error: e.message });
    }
  }

  // 下载最终静态 OpenAPI 规范（AnythingMCP Auto-Import 用）
  if (method === 'GET' && sub === 'openapi') {
    let content;
    try { content = readStaticOpenApi().content; }
    catch (e) { return send(404, { ok: false, error: String(e.message || e) }); }
    const filename = 'openapi.yaml';
    res.writeHead(200, { 'Content-Type': 'application/yaml; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store' });
    res.end(content);
    return;
  }

  // MCP 接入信息看板：只返回连接信息；JWT 必须由管理员显式签发。
  if (method === 'GET' && sub === 'mcp-info') {
    // 端点前缀以当前部署目录的 .env 为准，避免本地/内网环境误显示默认公网地址。
    const configuredEnv = { ...process.env, ...envfile.read(path.join(DEPLOY_DIR, '.env')).data };
    const cubeBase = configuredEnv.CUBE_PUBLIC_BASE || 'http://127.0.0.1:18080';
    const amcpBase = configuredEnv.ANYTHINGMCP_PUBLIC_BASE || '';
    const mcpEndpoint = cubeBase + '/mcp';
    const mcpStatus = await probeNativeMcp(mcpEndpoint);
    const tools = parseCubeCoreTools().map((item) => item.name);
    const nativeTools = ['cube_meta', 'cube_meta_detail', 'cube_glossary_resolve', 'cube_search', 'cube_dry_run', 'cube_load'];
    return send(200, {
      ok: true,
      nativeMcp: {
        endpoint: mcpEndpoint,
        transport: 'streamable-http',
        auth: 'Authorization: Bearer <CubeBuddy JWT>',
        tools: nativeTools,
        status: mcpStatus,
      },
      mcpServers: currentMcpServers().map((server) => ({
        ...mcpServerView(server),
        endpoint: server.id === 'default' ? mcpEndpoint : `${mcpEndpoint}/${server.id}`,
      })),
      cube: {
        base: cubeBase,
        openapi: cubeBase + '/openapi.yaml',
        readyz: cubeBase + '/readyz',
        meta:    cubeBase + '/cubejs-api/v1/meta',
        load:    cubeBase + '/cubejs-api/v1/load',
        search:  cubeBase + '/cubejs-api/v1/search',
        tools,
      },
      anythingmcp: amcpBase ? {
        base: amcpBase,
        endpointGlobal: amcpBase + '/mcp',
        endpointServerTpl: amcpBase + '/mcp/<id>',
      } : null,
      hasSecret: !!envSecret(),
    });
  }

  // ============ 术语表（一个标准术语对应多个别名） ============
  // 列表
  if (method === 'GET' && sub === 'glossary') {
    return send(200, { ok: true, items: glos.list(DEPLOY_DIR) });
  }
  // 新增/更新（standard 相同则覆盖别名集合和描述；兼容旧 alias 参数）
  if (method === 'POST' && sub === 'glossary') {
    const body = await readBody(req);
    try {
      const r = glos.upsert(DEPLOY_DIR, body.aliases || body.alias, body.standard, body.description);
      return send(200, { ok: true, ...r });
    } catch (e) { return send(400, { ok: false, error: e.message }); }
  }
  // 删除
  if (method === 'DELETE' && sub === 'glossary') {
    try {
      const r = glos.remove(DEPLOY_DIR, {
        standard: url.searchParams.get('standard'),
        alias: url.searchParams.get('alias'),
      });
      return send(200, { ok: true, ...r });
    } catch (e) { return send(400, { ok: false, error: e.message }); }
  }
  // 业务术语独立迁移包（不依赖 Compose，也不包含任何密钥）
  if (method === 'GET' && sub === 'glossary/export') {
    const payload = {
      format: 'cube-glossary',
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      items: glos.list(DEPLOY_DIR),
    };
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="cube-glossary.json"', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(payload, null, 2));
  }
  // 批量导入
  if (method === 'POST' && sub === 'glossary/import') {
    const body = await readBody(req);
    try {
      const source = body.package && typeof body.package === 'object' ? body.package : body;
      let items = source.items;
      if (!Array.isArray(items) && typeof body.text === 'string') {
        items = glos.parseImportLines(body.text);
      }
      const glossaryPath = path.join(DEPLOY_DIR, 'glossary', 'glossary.json');
      if (fs.existsSync(glossaryPath)) fs.copyFileSync(glossaryPath, glossaryPath + '.bak');
      const r = body.mode === 'replace' ? glos.replaceAll(DEPLOY_DIR, items) : glos.bulkImport(DEPLOY_DIR, items);
      return send(200, { ok: true, ...r, backup: fs.existsSync(glossaryPath + '.bak') ? glossaryPath + '.bak' : null });
    } catch (e) { return send(400, { ok: false, error: e.message }); }
  }
  // 生成 Agent 提示词
  if (method === 'GET' && sub === 'glossary/prompt') {
    return send(200, { ok: true, prompt: glos.toPrompt(DEPLOY_DIR) });
  }
  // 文本解析（Agent 归一化用）
  if (method === 'POST' && sub === 'glossary/resolve') {
    const body = await readBody(req);
    return send(200, { ok: true, hits: glos.resolveText(DEPLOY_DIR, body.text) });
  }
  // 下载原始 JSON
  if (method === 'GET' && sub === 'glossary/raw') {
    const p = path.join(DEPLOY_DIR, 'glossary', 'glossary.json');
    if (!fs.existsSync(p)) return send(404, { ok: false, error: '术语表尚未初始化' });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="glossary.json"', 'Cache-Control': 'no-store' });
    return fs.createReadStream(p).pipe(res);
  }

  return send(404, { ok: false, error: '接口不存在: ' + sub });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const method = req.method;

  if (url.pathname === '/healthz') {
    return sendJson(res, 200, { ok: true, service: 'cube-console-next' });
  }

  // CubeBuddy 原生 MCP：/mcp 是 default 兼容入口，/mcp/:id 为独立 MCP Server。
  const mcpRoute = url.pathname.match(/^\/mcp(?:\/([a-z][a-z0-9-]{0,62}))?\/?$/);
  if (mcpRoute) {
    const serverId = mcpRoute[1] || 'default';
    const mcpServer = mcpServerById(serverId);
    if (!mcpServer || !mcpServer.enabled) return sendJson(res, 404, { ok: false, error: 'MCP Server 不存在或已停用' });
    nativeMcpForServer(mcpServer).handle(req, res).catch((error) => {
      if (!res.headersSent) return sendJson(res, 500, { ok: false, error: 'MCP 请求处理失败' });
      console.error(`MCP response error: ${error.message || error}`);
    });
    return;
  }

  // Cube Core health endpoints are public and are proxied to the configured Cube API.
  if (method === 'GET' && (url.pathname === '/readyz' || url.pathname === '/livez')) {
    return proxyCubeHealth(res, url);
  }

  // 对外发布最终静态 Spec；请求时不再执行动态合并、过滤或 Schema 重写。
  if (method === 'GET' && ['/openapi.yaml', '/openapi.json'].includes(url.pathname)) {
    try {
      const source = readStaticOpenApi();
      const isJson = url.pathname.endsWith('.json');
      res.writeHead(200, { 'Content-Type': isJson ? 'application/json; charset=utf-8' : 'application/yaml; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(isJson ? JSON.stringify(source.spec, null, 2) : source.content);
    } catch (e) {
      return sendJson(res, 404, { ok: false, error: String(e.message || e) });
    }
  }

  // 空 favicon.ico（避免 404 噪音；Cube 配置 UI 不需要真实图标）
  if (url.pathname === '/favicon.ico') {
    res.writeHead(204, { 'Cache-Control': 'no-store' });
    return res.end();
  }

  // Cube 原生查询工具统一从新配置台入口转发，并在入口统一校验 JWT。
  if (['/cubejs-api/v1/load', '/cubejs-api/v1/sql', '/cubejs-api/v1/dry-run'].includes(url.pathname)) {
    return proxyCubeTool(req, res, url);
  }

  // ---- cube meta 代理：GET /cubejs-api/v1/meta 或 /cubejs-api/v1/meta/{name} ----
  // Published contract: root returns summary; a named path returns full metadata.
  // `mode` remains accepted as an undocumented compatibility alias for one
  // transition period, so existing clients are not broken by the MCP cleanup.
  if (method === 'GET' && (url.pathname === '/cubejs-api/v1/meta' || url.pathname.startsWith('/cubejs-api/v1/meta/'))) {
    (async () => {
      try {
        if (!cubeToolAuthOk(req)) return sendJson(res, 401, { ok: false, error: '未授权：需要 Cube API JWT' });
        const name = url.pathname === '/cubejs-api/v1/meta' ? '' : decodeURIComponent(url.pathname.slice('/cubejs-api/v1/meta/'.length).split('/')[0]);
        const requestedMode = url.searchParams.get('mode');
        if (requestedMode && !['summary', 'full'].includes(requestedMode)) return sendJson(res, 400, { ok: false, error: 'mode 只能是 summary 或 full' });
        const mode = requestedMode || (name ? 'full' : 'summary');
        const auth = req.headers.authorization || '';
        const r = await fetch(API_BASE + '/cubejs-api/v1/meta', {
          headers: auth ? { Authorization: auth } : {},
        });
        const text = await r.text();
        if (!r.ok) {
          res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          return res.end(text);
        }
        let meta;
        try { meta = JSON.parse(text); } catch (e) {
          res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          return res.end(text);
        }
        let cubes = meta.cubes || [];
        if (name) {
          const hit = cubes.find((c) => c.name === name);
          if (!hit) {
            return sendJson(res, 404, { ok: false, error: 'cube 不存在: ' + name, available: cubes.map((c) => c.name) });
          }
          cubes = [hit];
        }
        if (mode === 'summary' && !name) {
          cubes = cubes.map((c) => ({
            name: c.name,
            title: c.title,
            description: c.description,
            measureCount: Array.isArray(c.measures) ? c.measures.length : 0,
            dimensionCount: Array.isArray(c.dimensions) ? c.dimensions.length : 0,
            segmentCount: Array.isArray(c.segments) ? c.segments.length : 0,
          }));
        } else if (mode === 'summary') {
          cubes = cubes.map((c) => ({
            name: c.name,
            title: c.title,
            description: c.description,
            measures: (c.measures || []).map((m) => ({ name: m.name, title: m.title, type: m.type, aggType: m.aggType })),
            dimensions: (c.dimensions || []).map((d) => ({ name: d.name, title: d.title, type: d.type })),
            segments: (c.segments || []).map((s) => ({ name: s.name, title: s.title })),
          }));
        }
        const out = { cubes, summary: mode === 'summary', generatedAt: Date.now() };
        const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
        if (requestedMode) headers['X-Cube-Console-Deprecated'] = 'query parameter mode; use the fixed summary/detail endpoint contract';
        res.writeHead(200, headers);
        return res.end(JSON.stringify(out));
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: String(e.message || e) });
      }
    })();
    return;
  }

  // ---- cube dimension_search 代理：/cubejs-api/v1/search ----
  // Cube 无原生 search API，这里把 {dimension, query} 翻译成 /load + contains filter，
  // Authorization 头原样透传给 Cube 验签（无需持有密钥）。
  if (method === 'POST' && url.pathname === '/cubejs-api/v1/search') {
    readBody(req).then(async (body) => {
      try {
        if (!cubeToolAuthOk(req)) return sendJson(res, 401, { ok: false, error: '未授权：需要 Cube API JWT' });
        const dimension = String(body.dimension || '').trim();
        const q = String(body.query || '').trim();
        if (!dimension || !q) return sendJson(res, 400, { ok: false, error: 'dimension 和 query 必填' });
        const limit = Math.min(Math.max(parseInt(body.limit, 10) || 100, 1), 500);
        const auth = req.headers.authorization || '';
        const r = await fetch(API_BASE + '/cubejs-api/v1/load', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(auth ? { Authorization: auth } : {}),
          },
          body: JSON.stringify({
            query: {
              dimensions: [dimension],
              filters: [{ member: dimension, operator: 'contains', values: [q] }],
              limit,
            },
          }),
        });
        const text = await r.text();
        res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(text);
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: String(e.message || e) });
      }
    });
    return;
  }

  // ---- 术语表 resolve 代理：/cubejs-api/v1/glossary-resolve ----
  // Agent 智能问数归一化：输入文本 → 命中术语（口语/简称 → 标准术语）。
  // 数据在配置 UI 本地（glossary/glossary.json），不需要调 Cube。
  if (method === 'POST' && url.pathname === '/cubejs-api/v1/glossary-resolve') {
    readBody(req).then((body) => {
      try {
        if (!cubeToolAuthOk(req)) return sendJson(res, 401, { ok: false, error: '未授权：需要 Cube API JWT' });
        const text = String(body.text || '').trim();
        if (!text) return sendJson(res, 400, { ok: false, error: 'text 必填' });
        const hits = glos.resolveText(DEPLOY_DIR, text);
        return sendJson(res, 200, { ok: true, hits });
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: String(e.message || e) });
      }
    });
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((e) => sendJson(res, 500, { ok: false, error: String(e.message || e) }));
    return;
  }
  serveStatic(res, url.pathname);
});

server.listen(PORT, HOST, () => {
  const address = server.address();
  const actualPort = address && typeof address === 'object' ? address.port : PORT;
  console.log(`✅ Cube 配置 UI 已启动: http://${HOST}:${actualPort}`);
  console.log(`   部署目录: ${DEPLOY_DIR} | Cube API: ${API_BASE}`);
  console.log(`   Admin token: ${ADMIN_TOKEN ? '已配置（请保管）' : '⚠️ 未配置 CUBE_UI_ADMIN_TOKEN，登录接口将不可用！'}`);
  console.log(`   原生 MCP: http://${HOST}:${actualPort}/mcp`);
});

async function closeServer(signal) {
  console.log(`收到 ${signal}，正在关闭 CubeBuddy...`);
  await Promise.all([...nativeMcpCache.values()].map((handler) => handler.close().catch(() => {})));
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}

process.once('SIGTERM', () => { void closeServer('SIGTERM'); });
process.once('SIGINT', () => { void closeServer('SIGINT'); });
