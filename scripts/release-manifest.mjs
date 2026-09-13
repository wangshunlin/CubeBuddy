import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const valueOf = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const root = path.resolve(valueOf('--root', process.cwd()));
const output = path.resolve(valueOf('--output', path.join(root, 'release-manifest.json')));
const revision = valueOf('--revision', process.env.BUILD_REVISION || 'development');
const createdAt = valueOf('--created-at', new Date().toISOString());

const files = [
  'Dockerfile',
  'compose.yml',
  'compose.build.yml',
  'package.json',
  'package-lock.json',
  'public/index.html',
  'public/app.js',
  'public/styles/typography.css',
  'server/server.js',
  'server/lib/cube-tools.js',
  'server/lib/glossary.js',
  'server/lib/jwt.js',
  'server/mcp/contracts.ts',
  'server/mcp/index.ts',
  'server/mcp/server.ts',
  'scripts/test-mcp-e2e.mjs',
];

const hashes = {};
for (const relative of files) {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) throw new Error(`发布文件不存在：${relative}`);
  const data = fs.readFileSync(absolute);
  hashes[relative] = {
    sha256: crypto.createHash('sha256').update(data).digest('hex'),
    size: data.length,
  };
}

const manifest = {
  schemaVersion: 1,
  revision,
  createdAt,
  files: hashes,
  containerFiles: [
    'public/index.html',
    'public/app.js',
    'public/styles/typography.css',
    'server/server.js',
    'server/lib/cube-tools.js',
    'server/lib/glossary.js',
    'server/lib/jwt.js',
  ],
};

fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`发布清单已生成：${output}`);
