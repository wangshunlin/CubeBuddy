'use strict';
// .env 读取 / 更新（保留注释与行序，最小改动）
const fs = require('fs');

function parse(text) {
  const lines = [];
  const data = {};
  text.split(/\r?\n/).forEach((raw) => {
    const m = raw.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) {
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      data[m[1]] = v;
      lines.push({ raw, key: m[1], value: v });
    } else {
      lines.push({ raw, key: null, value: null });
    }
  });
  return { data, lines };
}

function read(path) {
  if (!fs.existsSync(path)) return { data: {}, lines: [] };
  return parse(fs.readFileSync(path, 'utf8'));
}

function update(parsed, updates) {
  const out = [];
  const seen = new Set();
  for (const l of parsed.lines) {
    if (l.key && Object.prototype.hasOwnProperty.call(updates, l.key)) {
      out.push(`${l.key}=${String(updates[l.key])}`);
      seen.add(l.key);
    } else {
      out.push(l.raw);
    }
  }
  for (const k of Object.keys(updates)) {
    if (!seen.has(k)) out.push(`${k}=${String(updates[k])}`);
  }
  return out.join('\n') + '\n';
}

// 全量写回：以 data 的键为准重写整个文件（不在 data 中的旧键会被移除），
// 非 KV 行（注释/空行）保留在原位置
function write(path, data) {
  const parsed = fs.existsSync(path) ? read(path) : { lines: [] };
  const out = [];
  const seen = new Set();
  for (const l of parsed.lines) {
    if (l.key && Object.prototype.hasOwnProperty.call(data, l.key)) {
      out.push(`${l.key}=${String(data[l.key])}`);
      seen.add(l.key);
    } else if (!l.key) {
      out.push(l.raw);
    }
  }
  for (const k of Object.keys(data)) {
    if (!seen.has(k)) out.push(`${k}=${String(data[k])}`);
  }
  const text = out.join('\n') + '\n';
  fs.writeFileSync(path, text, 'utf8');
  return { path, count: Object.keys(data).length };
}

module.exports = { parse, read, update, write };
