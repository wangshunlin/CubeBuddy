'use strict';

// MCP Server 配置及语义模型白名单。
// 每个 Server 只是同一 Cube API 上的逻辑访问边界，不会创建额外容器。
const fs = require('fs');
const path = require('path');

const CONFIG_NAME = 'mcp-servers.json';
const ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;

class McpAccessError extends Error {
  constructor(message, code = 'model_not_allowed') {
    super(message);
    this.name = 'McpAccessError';
    this.status = 403;
    this.code = code;
  }
}

function configPath(deployDir) {
  return path.join(deployDir, CONFIG_NAME);
}

function normalizeServer(input, { requiredId = true } = {}) {
  if (!input || typeof input !== 'object') throw new Error('MCP Server 配置无效');
  const id = String(input.id || '').trim();
  if (requiredId && !ID_PATTERN.test(id)) {
    throw new Error('Server ID 必须以小写字母开头，只能包含小写字母、数字和连字符');
  }
  const modelIds = [...new Set((Array.isArray(input.modelIds) ? input.modelIds : [])
    .map((item) => String(item || '').trim()).filter(Boolean))];
  if (!modelIds.length && id !== 'default') throw new Error('至少绑定一个语义模型');
  return {
    id,
    name: String(input.name || '').trim().slice(0, 80) || id,
    instructions: String(input.instructions || '').trim().slice(0, 2000),
    enabled: input.enabled !== false,
    modelIds,
    createdAt: String(input.createdAt || new Date().toISOString()),
    updatedAt: new Date().toISOString(),
  };
}

function read(deployDir) {
  try {
    const value = JSON.parse(fs.readFileSync(configPath(deployDir), 'utf8'));
    const servers = Array.isArray(value?.servers) ? value.servers : [];
    return { version: 1, servers: servers.map((item) => normalizeServer(item)).filter(Boolean) };
  } catch (_) {
    return { version: 1, servers: [] };
  }
}

function write(deployDir, servers) {
  const normalized = servers.map((item) => normalizeServer(item));
  const ids = new Set();
  normalized.forEach((item) => {
    if (ids.has(item.id)) throw new Error(`Server ID 已存在：${item.id}`);
    ids.add(item.id);
  });
  const target = configPath(deployDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ version: 1, servers: normalized }, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, target);
  try { fs.chmodSync(target, 0o600); } catch (_) { /* best effort */ }
  return { version: 1, servers: normalized };
}

function ensureDefault(deployDir, modelIds) {
  const current = read(deployDir);
  if (current.servers.length) return current;
  const ids = [...new Set((modelIds || []).map(String).filter(Boolean))];
  return write(deployDir, [{
    id: 'default', name: '默认 MCP Server',
    instructions: '', enabled: true, modelIds: ids,
  }]);
}

function find(deployDir, id) {
  return read(deployDir).servers.find((item) => item.id === id) || null;
}

function create(deployDir, input, availableModelIds) {
  const next = normalizeServer(input);
  const allowed = new Set(availableModelIds || []);
  const invalid = next.modelIds.filter((id) => !allowed.has(id));
  if (invalid.length) throw new Error(`语义模型不存在：${invalid.join('、')}`);
  const current = read(deployDir);
  if (current.servers.some((item) => item.id === next.id)) throw new Error('Server ID 已存在');
  return write(deployDir, [...current.servers, next]).servers.find((item) => item.id === next.id);
}

function update(deployDir, id, patch, availableModelIds) {
  const current = read(deployDir);
  const index = current.servers.findIndex((item) => item.id === id);
  if (index < 0) throw new Error('MCP Server 不存在');
  const next = normalizeServer({ ...current.servers[index], ...patch, id, createdAt: current.servers[index].createdAt });
  const allowed = new Set(availableModelIds || []);
  const invalid = next.modelIds.filter((modelId) => !allowed.has(modelId));
  if (invalid.length) throw new Error(`语义模型不存在：${invalid.join('、')}`);
  current.servers[index] = next;
  return write(deployDir, current.servers).servers[index];
}

function remove(deployDir, id) {
  if (id === 'default') throw new Error('默认 MCP Server 不能删除，可停用或修改绑定模型');
  const current = read(deployDir);
  const next = current.servers.filter((item) => item.id !== id);
  if (next.length === current.servers.length) throw new Error('MCP Server 不存在');
  write(deployDir, next);
}

function modelNameFromMember(member) {
  const value = String(member || '').trim();
  const dot = value.indexOf('.');
  return dot > 0 ? value.slice(0, dot) : '';
}

function queryMembers(query) {
  const members = new Set();
  const add = (value) => { if (typeof value === 'string' && value.trim()) members.add(value.trim()); };
  const walkFilters = (filters) => (Array.isArray(filters) ? filters : []).forEach((filter) => {
    if (!filter || typeof filter !== 'object') return;
    add(filter.member || filter.dimension);
    walkFilters(filter.and);
    walkFilters(filter.or);
  });
  const value = query && typeof query === 'object' ? query : {};
  ['measures', 'dimensions', 'segments'].forEach((key) => (Array.isArray(value[key]) ? value[key] : []).forEach(add));
  (Array.isArray(value.timeDimensions) ? value.timeDimensions : []).forEach((item) => add(item?.dimension));
  walkFilters(value.filters);
  if (Array.isArray(value.order)) value.order.forEach((item) => {
    if (Array.isArray(item)) add(item[0]);
    else if (item && typeof item === 'object') Object.keys(item).forEach(add);
  });
  else if (value.order && typeof value.order === 'object') Object.keys(value.order).forEach(add);
  return [...members];
}

function createScopedCubeToolService(service, server) {
  const allowedModels = new Set(server.modelIds);
  const assertMember = (member) => {
    const modelId = modelNameFromMember(member);
    if (!modelId || !allowedModels.has(modelId)) {
      throw new McpAccessError(`当前 MCP Server 无权访问语义模型 ${modelId || '未知'}`);
    }
  };
  const assertQuery = (query) => queryMembers(query).forEach(assertMember);
  return {
    async meta(input = {}) {
      if (input.name && !allowedModels.has(input.name)) throw new McpAccessError(`当前 MCP Server 无权访问语义模型 ${input.name}`);
      const result = await service.meta(input);
      return { ...result, cubes: (Array.isArray(result.cubes) ? result.cubes : []).filter((cube) => allowedModels.has(cube?.name)) };
    },
    async load(input = {}) { assertQuery(input.query); return service.load(input); },
    async dryRun(input = {}) { assertQuery(input.query); return service.dryRun(input); },
    async search(input = {}) { assertMember(input.dimension); return service.search(input); },
    glossaryResolve(input = {}) { return service.glossaryResolve(input); },
  };
}

module.exports = {
  CONFIG_NAME, McpAccessError, configPath, read, write, ensureDefault, find, create, update, remove,
  normalizeServer, queryMembers, createScopedCubeToolService,
};
