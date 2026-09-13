import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

for (const script of ['scripts/deploy-aliyun.sh', 'scripts/rollback-aliyun.sh']) {
  execFileSync('bash', ['-n', script], { stdio: 'inherit' });
}

const deploySource = readFileSync('scripts/deploy-aliyun.sh', 'utf8');
for (const marker of [
  'build cube_console cube_gateway',
  'up -d --no-build --force-recreate cube_console cube_gateway',
  'CUBE_RELEASE_GATEWAY_IMAGE',
  '--gateway-container cube-console-cube_gateway-1',
]) {
  if (!deploySource.includes(marker)) throw new Error(`发布脚本缺少双镜像发布标记：${marker}`);
}
const rollbackSource = readFileSync('scripts/rollback-aliyun.sh', 'utf8');
for (const marker of ['GATEWAY_IMAGE', 'cube_console cube_gateway', 'CUBE_RELEASE_GATEWAY_IMAGE']) {
  if (!rollbackSource.includes(marker)) throw new Error(`回滚脚本缺少双镜像回滚标记：${marker}`);
}

for (const script of [
  'scripts/release-manifest.mjs',
  'scripts/update-env-value.mjs',
  'scripts/verify-deployment.mjs',
]) {
  execFileSync(process.execPath, ['--check', script], { stdio: 'inherit' });
}

const composeCheckEnv = {
  ...process.env,
  CUBE_COMPOSE_ENV_READ_PATH: '.env.example',
  CUBE_COMPOSE_ENV_HOST_PATH: '.env.example',
};

const production = execFileSync('docker', [
  'compose', '-f', 'compose.yml', '--env-file', '.env.example', 'config',
], { encoding: 'utf8', env: composeCheckEnv });
if (/^\s+build:/m.test(production)) {
  throw new Error('生产 compose.yml 不得包含 build 配置');
}

const composeSource = readFileSync('compose.yml', 'utf8');
if (/\/opt\/cube-console(?::|\/)/.test(composeSource)) {
  throw new Error('发布快照和运行配置不得嵌套挂载到 /opt/cube-console');
}
if (!/CUBE_COMPOSE_ENV_READ_PATH/.test(composeSource)) {
  throw new Error('Compose CLI 读取路径与宿主机绑定路径必须分离');
}

const indexSource = readFileSync('public/index.html', 'utf8');
const scriptSources = [...indexSource.matchAll(/<script\s+[^>]*src=["']([^"']+)["'][^>]*>/g)].map((match) => match[1]);
if (scriptSources.length !== 1 || scriptSources[0] !== './app.js') {
  throw new Error(`前端必须只有 app.js 一个运行时入口，实际为：${scriptSources.join(', ') || '无'}`);
}
if (existsSync('public/real-runtime.js')) {
  throw new Error('public/real-runtime.js 已废弃，真实 API 逻辑必须合并到 public/app.js');
}
const appSource = readFileSync('public/app.js', 'utf8');
if (/prototype(?:HandleAction|BindPage)|^[A-Za-z_$][\w$]*\s*=\s*(?:async\s+)?function\s+real/m.test(appSource)) {
  throw new Error('app.js 不得通过运行时赋值覆盖基础函数');
}

const build = execFileSync('docker', [
  'compose', '-f', 'compose.yml', '-f', 'compose.build.yml', '--env-file', '.env.example', 'config',
], { encoding: 'utf8', env: composeCheckEnv });
if (!/^\s+build:/m.test(build)) {
  throw new Error('compose.build.yml 未提供构建配置');
}

console.log('发布配置检查通过：生产仅使用镜像，构建覆盖文件有效，前端为单运行时入口');
