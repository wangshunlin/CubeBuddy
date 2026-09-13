// ============================================================
// 多数据源管理 lib — 零依赖
// 存储：<deployDir>/datasources.json  { sources: [ {name,type,host,port,database,user,password,ssl,container} ] }
// 默认源：name=default 时使用裸 CUBEJS_DB_* 变量；也允许没有 default，甚至没有任何数据源
// 命名源：CUBEJS_DS_<NAME>_DB_*（Cube v1 官方多数据源语法）
// 自动建模连接：优先 docker exec <container>（本机容器），否则宿主客户端
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');
const envfile = require('./envfile');

const SYS_DBS = ['mysql', 'information_schema', 'performance_schema', 'sys', 'postgres', 'template0', 'template1'];

function filePath(deployDir) {
  return path.join(deployDir, 'datasources.json');
}

function runtimeEnv(deployDir) {
  const state = envfile.read(path.join(deployDir, '.env')).data;
  // Compose 的 env_file 是 Cube 实际使用的运行时来源。配置台容器可能刚启动、
  // 还没有生成 state/.env，因此同时读取挂载的 Compose env 和进程环境，避免
  // 首次进入内网时数据源列表为空。
  const composePath = process.env.CUBE_COMPOSE_ENV_PATH || '';
  const compose = composePath ? envfile.read(composePath).data : {};
  return { ...process.env, ...compose, ...state };
}

function persistedEnv(deployDir) {
  const state = envfile.read(path.join(deployDir, '.env')).data;
  const composePath = process.env.CUBE_COMPOSE_ENV_PATH || '';
  const compose = composePath ? envfile.read(composePath).data : {};
  return { ...compose, ...state };
}

// 读取数据源列表；无配置文件时从 .env 提取默认源
function read(deployDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath(deployDir), 'utf8'));
    if (Array.isArray(raw.sources)) return raw.sources;
  } catch (_) { /* 无配置则从 .env 构建 */ }
  const data = runtimeEnv(deployDir);
  const def = {
    name: 'default',
    type: data.CUBEJS_DB_TYPE || 'mysql',
    host: data.CUBEJS_DB_HOST || '',
    port: data.CUBEJS_DB_PORT || '',
    database: data.CUBEJS_DB_NAME || '',
    user: data.CUBEJS_DB_USER || '',
    password: data.CUBEJS_DB_PASS || '',
    ssl: data.CUBEJS_DB_SSL === 'true',
    container: '',
  };
  return [def];
}

function write(deployDir, sources) {
  fs.mkdirSync(path.dirname(filePath(deployDir)), { recursive: true });
  fs.writeFileSync(filePath(deployDir), JSON.stringify({ sources }, null, 2), 'utf8');
}

// 校验 name 合法性（Cube 规则：字母开头、字母数字下划线；default 可选）
function validName(name) {
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(String(name || ''));
}

// 新增/更新（同名覆盖）
function upsert(deployDir, src) {
  const name = String(src.name || '').trim();
  if (!validName(name)) throw new Error('数据源名非法：字母开头、仅字母数字下划线（default 为保留名）');
  const oldName = String(src.oldName || '').trim();
  const sources = read(deployDir);
  const existingName = oldName || name;
  const hitIndex = sources.findIndex((s) => s.name === existingName);
  if (oldName && oldName !== name && hitIndex < 0) throw new Error('原数据源不存在: ' + oldName);
  const nameOwnerIndex = sources.findIndex((s) => s.name === name);
  if (oldName && oldName !== name && nameOwnerIndex >= 0) throw new Error('数据源名称已存在: ' + name);
  const hit = hitIndex >= 0 ? sources[hitIndex] : null;
  const item = {
    name,
    type: String(src.type || 'mysql'),
    host: String(src.host || ''),
    port: String(src.port || ''),
    database: String(src.database || ''),
    user: String(src.user || ''),
    password: src.password && !/^•+$/.test(String(src.password)) ? String(src.password) : (hit ? String(hit.password || '') : ''),
    ssl: !!src.ssl,
    container: String(src.container || ''),
  };
  if (hit) sources[hitIndex] = item;
  else sources.push(item);
  write(deployDir, sources);
  return { name, oldName: oldName || name, created: !hit, renamed: Boolean(oldName && oldName !== name), sources: sources.map((s) => mask(s)) };
}

function remove(deployDir, name) {
  const sources = read(deployDir);
  const next = sources.filter((s) => s.name !== String(name || ''));
  if (next.length === sources.length) throw new Error('数据源不存在: ' + name);
  write(deployDir, next);
  return { removed: name };
}

// 脱敏（前端展示）
function mask(s) {
  return { ...s, password: s.password ? '••••••' : '' };
}

// 把数据源渲染为 .env 的 DB 环境变量（保留其它变量），返回更新后的 env 对象
function buildEnv(deployDir) {
  const env = persistedEnv(deployDir);
  const sources = read(deployDir);
  const env2 = { ...env };
  // 清掉旧的 DB 变量（默认源 + 命名源），避免残留
  Object.keys(env2).forEach((k) => {
    if (k === 'CUBEJS_DB_TYPE' || k === 'CUBEJS_DB_HOST' || k === 'CUBEJS_DB_PORT' ||
        k === 'CUBEJS_DB_NAME' || k === 'CUBEJS_DB_USER' || k === 'CUBEJS_DB_PASS' ||
        k === 'CUBEJS_DB_SSL' || k.startsWith('CUBEJS_DS_') || k === 'CUBEJS_DATASOURCES') {
      delete env2[k];
    }
  });
  const named = sources.filter((s) => s.name !== 'default');
  const def = sources.find((s) => s.name === 'default');
  // Cube 运行时要求 CUBEJS_DATASOURCES 始终包含 default；当界面没有显式
  // default 时，用第一条数据源生成运行时别名，但不把它写回数据源列表。
  const runtimeDefault = def || sources[0];
  if (runtimeDefault) setDbVars(env2, 'CUBEJS_', runtimeDefault);
  // 命名源 → CUBEJS_DS_<NAME>_DB_*
  named.forEach((s) => setDbVars(env2, `CUBEJS_DS_${s.name.toUpperCase()}_`, s));
  // 数据源清单；没有数据源时移除该变量，避免伪造一个 default 绑定。
  if (sources.length) {
    const names = sources.map((s) => s.name.toLowerCase());
    if (!def && !names.includes('default')) names.unshift('default');
    env2.CUBEJS_DATASOURCES = names.join(',');
  }
  else delete env2.CUBEJS_DATASOURCES;
  return env2;
}

function setDbVars(env, prefix, s) {
  env[prefix + 'DB_TYPE'] = s.type || 'mysql';
  if (s.host) env[prefix + 'DB_HOST'] = s.host;
  if (s.port) env[prefix + 'DB_PORT'] = s.port;
  if (s.database) env[prefix + 'DB_NAME'] = s.database;
  if (s.user) env[prefix + 'DB_USER'] = s.user;
  if (s.password) env[prefix + 'DB_PASS'] = s.password;
  if (s.ssl) env[prefix + 'DB_SSL'] = 'true';
}

// 应用：写 .env + 返回变更摘要
function apply(deployDir, { allowEmpty = false } = {}) {
  if (!allowEmpty && !read(deployDir).length) {
    throw new Error('当前没有数据源；可以先保存空列表，但添加至少一个数据源后才能应用到 Cube');
  }
  const env = buildEnv(deployDir);
  const { path: p } = envfile.write(path.join(deployDir, '.env'), env);
  return {
    path: p,
    datasources: env.CUBEJS_DATASOURCES || '',
    summary: (env.CUBEJS_DATASOURCES || '').split(',').map((n) => n.trim()).filter(Boolean),
  };
}

module.exports = { read, write, upsert, remove, mask, buildEnv, apply, SYS_DBS };
