'use strict';
// 与 docker / Cube API 交互（零依赖，Node 20 内置 fetch）
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const jwt = require('./jwt');

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 180000, ...opts }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err ? err.code : 0,
        stdout: (stdout || '').trim(),
        stderr: (stderr || '').trim(),
        error: err ? err.message : null,
      });
    });
  });
}

function composeFile(deployDir) {
  if (process.env.CUBE_COMPOSE_FILE) return process.env.CUBE_COMPOSE_FILE;

  const candidates = [];
  if (process.env.CUBE_COMPOSE_ENV_PATH) {
    const envPath = path.resolve(process.env.CUBE_COMPOSE_ENV_PATH);
    candidates.push(path.join(path.dirname(envPath), 'compose.yml'));
    candidates.push(path.join(path.dirname(envPath), 'docker-compose.yml'));
  }
  const projectRoot = path.resolve(__dirname, '../..');
  candidates.push(path.join(projectRoot, 'compose.yml'));
  candidates.push(path.join(projectRoot, 'docker-compose.yml'));
  candidates.push(path.join(deployDir, 'docker-compose.yml'));
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[candidates.length - 1];
}

function cubeNameKey(value) {
  return String(value || '').trim().replace(/\.ya?ml$/i, '');
}

// 配置台把宿主 compose.yml / .env 挂到容器内的 /tmp，再以该文件执行 docker compose。
// Compose 会把「compose 文件所在目录」当作项目目录，于是 compose 里的相对路径
// （挂载源、env_file）都会被解析成 /tmp/...；而 bind 挂载源最终由宿主机解析，
// 结果指向宿主机上并不存在的 /tmp/state（Docker 会自动创建空目录），
// 典型现象是 cube_api 看不到模型文件，报「Cube 编译后缺少模型」。
// 因此：只要是通过外部 compose 文件运行（配置台场景），这些宿主路径就必须是绝对路径。
const HOST_PATH_VARS = ['CUBE_DEPLOY_HOST_DIR', 'CUBE_CONSOLE_SOURCE_HOST_DIR', 'CUBE_COMPOSE_ENV_HOST_PATH'];

function assertAbsoluteHostPaths() {
  // 未指定外部 compose 文件时（手工在项目目录执行 compose），相对路径是安全的，保持原行为。
  if (!process.env.CUBE_COMPOSE_FILE) return;
  const relative = HOST_PATH_VARS
    .map((key) => [key, String(process.env[key] || '').trim()])
    .filter(([, value]) => value && !path.isAbsolute(value));
  if (!relative.length) return;
  throw new Error(
    `${relative.map(([key, value]) => `${key}=${value}`).join('、')} 必须是绝对路径。`
    + '配置台以容器内 /tmp 为项目目录执行 docker compose，相对路径会把宿主机挂载指向 /tmp，'
    + '导致 Cube 看不到模型文件（典型报错：「Cube 编译后缺少模型」）。'
    + '请在 .env 中改为宿主机上的绝对路径，例如 CUBE_DEPLOY_HOST_DIR=/opt/cube-console/state。',
  );
}

function compose(deployDir, args) {
  assertAbsoluteHostPaths();
  return run('docker', ['compose', '-f', composeFile(deployDir), ...args]);
}

function composeExec(deployDir, service, args, opts = {}) {
  return run('docker', ['compose', '-f', composeFile(deployDir), 'exec', '-T', service, ...args], opts);
}

async function composePs(deployDir) {
  const r = await run('docker', [
    'compose', '-f', composeFile(deployDir),
    'ps', '--format', 'json',
  ]);
  if (!r.ok || !r.stdout) return [];
  try {
    // compose v2 ps --format json 输出为 JSONL（每行一个对象），行首还可能混入 warning
    return r.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('{'))
      .map((l) => JSON.parse(l));
  } catch (e) {
    return [];
  }
}

// 用 .env 里的 CUBEJS_API_SECRET 签一个短期 JWT 调 /meta（真实校验模型是否生效）
async function cubeMeta(apiBase, secret) {
  if (!secret) throw new Error('CUBEJS_API_SECRET 缺失，无法校验');
  const token = jwt.sign({ secret, days: 1 });
  const res = await fetch(`${apiBase}/cubejs-api/v1/meta`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`meta HTTP ${res.status}`);
  const j = await res.json();
  return (j.cubes || []).map((c) => c.name);
}

async function readyz(apiBase) {
  try {
    const res = await fetch(`${apiBase}/readyz`, { signal: AbortSignal.timeout(5000) });
    return { status: res.status, body: await res.text() };
  } catch (e) {
    return { status: 0, body: String(e.message) };
  }
}

async function waitForCube(apiBase, secret, timeoutMs = 60000, expectedCubes = []) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '服务尚未就绪';
  const expected = [...new Set((Array.isArray(expectedCubes) ? expectedCubes : []).map(String).filter(Boolean))];
  while (Date.now() < deadline) {
    const ready = await readyz(apiBase);
    if (ready.status === 200) {
      // 只等待服务健康时，不调用会按 public 过滤结果的 /meta。
      if (!expected.length) return { ready, cubes: null };
      try {
        const cubes = await cubeMeta(apiBase, secret);
        const loaded = new Set(cubes.map(cubeNameKey));
        const missing = expected.filter((name) => !loaded.has(cubeNameKey(name)));
        if (!missing.length) return { ready, cubes };
        lastError = `Cube 尚未加载模型：${missing.join('、')}`;
      } catch (e) {
        lastError = e.message;
      }
    } else {
      lastError = ready.body || `readyz HTTP ${ready.status}`;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Cube 启动超时：${lastError}`);
}

// 「缺少模型」时补充可定位的对比信息：容器内模型数 vs 部署目录模型数。
// 两者不一致通常说明挂载路径解析错误（宿主路径变量写成了相对路径）。
async function mountDiagnosis(deployDir) {
  const probe = await composeExec(
    deployDir, 'cube_api',
    ['sh', '-c', 'ls -1 model/cubes 2>/dev/null | wc -l'],
    { timeout: 15000 },
  );
  const inContainer = (probe.stdout || '').trim() || '?';
  let onDisk = '?';
  try {
    onDisk = String(
      fs.readdirSync(path.join(deployDir, 'schema')).filter((name) => /\.ya?ml$/i.test(name)).length,
    );
  } catch (_) { /* 部署目录不可读时忽略统计 */ }
  const numbers = '（cube_api 容器内模型数=' + inContainer + '，部署目录模型数=' + onDisk + '）';
  if (inContainer === '0' && onDisk !== '0') {
    return numbers + ' → 容器没看到模型文件，通常是挂载路径解析错误：请确认 .env 中 '
      + 'CUBE_DEPLOY_HOST_DIR / CUBE_CONSOLE_SOURCE_HOST_DIR / CUBE_COMPOSE_ENV_HOST_PATH 都是宿主机绝对路径';
  }
  return numbers;
}

async function verifyCubeModels(deployDir, expectedCubes = []) {
  const probe = [
    "const { FileRepository } = require('@cubejs-backend/shared');",
    "const { compile } = require('@cubejs-backend/schema-compiler');",
    "(async () => {",
    "const compiler = await compile(new FileRepository('model/cubes'), { standalone: true });",
    "const names = compiler.cubeEvaluator.cubeNames();",
    "process.stdout.write(JSON.stringify({ names }));",
    "})().catch(error => { console.error(error.stack || error.message || String(error)); process.exit(1); });",
  ].join(' ');
  const result = await composeExec(deployDir, 'cube_api', ['node', '-e', probe], { timeout: 60000 });
  if (!result.ok) {
    throw new Error(`Cube 模型编译失败：${result.stderr || result.error || '未知错误'}`);
  }
  let payload;
  try { payload = JSON.parse(result.stdout || '{}'); }
  catch (_) { throw new Error(`Cube 模型编译结果无效：${result.stdout || '空响应'}`); }
  const loaded = new Set((Array.isArray(payload.names) ? payload.names : []).map(cubeNameKey));
  const expected = [...new Set((Array.isArray(expectedCubes) ? expectedCubes : []).map(cubeNameKey).filter(Boolean))];
  const missing = expected.filter((name) => !loaded.has(name));
  if (missing.length) throw new Error(`Cube 编译后缺少模型：${missing.join('、')}${await mountDiagnosis(deployDir)}`);
  return { names: payload.names || [] };
}

module.exports = { run, compose, composePs, cubeMeta, readyz, waitForCube, verifyCubeModels };
