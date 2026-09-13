import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';

const tracked = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
  encoding: 'utf8',
}).split('\0').filter(Boolean).filter(existsSync);

const failures = [];
const forbiddenFiles = [
  { test: (file) => file === '.env' || (/\.env(?:\.|$)/.test(file) && !file.endsWith('.env.example')), reason: '环境配置文件' },
  { test: (file) => file === 'state' || file.startsWith('state/'), reason: '运行状态目录' },
  { test: (file) => /(^|\/)(?:id_rsa|id_ed25519|credentials|secrets?)(?:\.|$)/i.test(file), reason: '凭证文件' },
  { test: (file) => ['.pem', '.p12', '.pfx'].includes(extname(file).toLowerCase()), reason: '密钥或证书文件' },
];

const forbiddenContent = [
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, reason: '私钥内容' },
  { pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/, reason: 'AWS Access Key' },
  { pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/, reason: 'GitHub Token' },
  { pattern: /\bsk-[A-Za-z0-9]{20,}\b/, reason: 'API Key' },
  { pattern: /\u5e7f\u4e1c\u7701\u5e94\u6025\u7ba1\u7406\u5385/, reason: '内部项目名称' },
  { pattern: /\/Users\/wangshunlin\//, reason: '本机绝对路径' },
  { pattern: /server_name\s+(?![a-z0-9.-]*example\.com|localhost|_)[^;]+;/i, reason: '未模板化的 Nginx 域名' },
];

const textExtensions = new Set([
  '', '.css', '.env', '.example', '.html', '.js', '.json', '.md', '.mjs', '.sh', '.ts', '.txt', '.yaml', '.yml',
]);

for (const file of tracked) {
  for (const rule of forbiddenFiles) {
    if (rule.test(file)) failures.push(`${file}: 不应公开的${rule.reason}`);
  }

  if (!textExtensions.has(extname(file).toLowerCase())) continue;
  const content = readFileSync(file, 'utf8');
  for (const rule of forbiddenContent) {
    if (rule.pattern.test(content)) failures.push(`${file}: 检测到${rule.reason}`);
  }
}

if (failures.length) {
  console.error('公开发布检查失败：');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`公开发布检查通过：已检查 ${tracked.length} 个文件`);
