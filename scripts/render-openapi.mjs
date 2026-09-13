import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const root = process.cwd();
const templatePath = process.env.OPENAPI_TEMPLATE_PATH || path.join(root, 'server', 'openapi', 'openapi.yaml');
const deployDir = process.env.CUBE_DEPLOY_DIR || '/opt/cube-deploy';
const targetPath = process.env.CUBE_OPENAPI_PATH || path.join(deployDir, 'openapi', 'openapi.yaml');
const publicBase = String(process.env.CUBE_PUBLIC_BASE || 'http://127.0.0.1:18080').replace(/\/$/, '');

function readSpec(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const document = YAML.parseDocument(content);
  if (document.errors.length) throw new Error(document.errors.map((error) => error.message).join('; '));
  const spec = document.toJS();
  if (!spec || typeof spec !== 'object' || !/^3\./.test(String(spec.openapi || ''))) throw new Error(`${filePath} 不是 OpenAPI 3.x 规范`);
  if (!spec.info || typeof spec.info !== 'object' || !spec.paths || typeof spec.paths !== 'object') throw new Error(`${filePath} 缺少 info 或 paths`);
  return spec;
}

const sourcePath = fs.existsSync(targetPath) ? targetPath : templatePath;
const spec = readSpec(sourcePath);
spec.servers = Array.isArray(spec.servers) && spec.servers.length ? spec.servers : [{ description: 'Cube Console 统一入口' }];
spec.servers[0] = { ...spec.servers[0], url: publicBase };
const rendered = YAML.stringify(spec);

fs.mkdirSync(path.dirname(targetPath), { recursive: true });
let current = '';
try { current = fs.readFileSync(targetPath, 'utf8'); } catch (_) { /* 首次部署 */ }
if (current !== rendered) {
  if (current) fs.copyFileSync(targetPath, `${targetPath}.bak`);
  fs.writeFileSync(targetPath, rendered, 'utf8');
  console.log(`OpenAPI 已写入 ${targetPath}（servers.url=${publicBase}）`);
} else {
  console.log(`OpenAPI 已是最新：${targetPath}`);
}
