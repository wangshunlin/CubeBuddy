import fs from 'node:fs';
import path from 'node:path';

const [envPathInput, key, value] = process.argv.slice(2);
if (!envPathInput || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key || '') || value === undefined) {
  console.error('用法：node scripts/update-env-value.mjs <env-path> <KEY> <value>');
  process.exit(2);
}

const envPath = path.resolve(envPathInput);
const original = fs.readFileSync(envPath, 'utf8');
const lines = original.split(/\r?\n/);
let found = false;
const updated = lines.map((line) => {
  if (!line.match(new RegExp(`^${key}\\s*=`))) return line;
  found = true;
  return `${key}=${value}`;
});
if (!found) updated.push(`${key}=${value}`);

const stat = fs.statSync(envPath);
const tempPath = `${envPath}.release-${process.pid}.tmp`;
fs.writeFileSync(tempPath, `${updated.join('\n').replace(/\n+$/, '')}\n`, { mode: stat.mode });
fs.chmodSync(tempPath, stat.mode);
fs.renameSync(tempPath, envPath);
console.log(`已更新 ${key}（值未输出）`);
