// ============================================================
// 术语表 lib — 零依赖（按标准术语分组）
// 存储：<deployDir>/glossary/glossary.json
// 结构：{ "items": [ { standard, description, aliases: [] }, ... ] }
// 用途：Agent 智能问数前的"口语/简称 → 标准术语"归一化
// 兼容：旧版 {items:[{alias,standard}]} 和分组结构会自动归并
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');

function filePath(deployDir) {
  return path.join(deployDir, 'glossary', 'glossary.json');
}

function cleanAliases(value) {
  const source = Array.isArray(value) ? value : [value];
  return [...new Set(source.map((item) => String(item || '').trim()).filter(Boolean))];
}

function normalizeItems(source) {
  const grouped = new Map();
  const add = (item) => {
    const standard = String(item && item.standard || '').trim();
    const aliases = cleanAliases(item && (item.aliases || item.alias));
    if (!standard || !aliases.length) return;
    const description = String(item && item.description || '').trim();
    const current = grouped.get(standard) || { standard, description: '', aliases: [] };
    current.aliases = cleanAliases([...current.aliases, ...aliases]);
    if (description) current.description = description;
    grouped.set(standard, current);
  };
  (source || []).forEach(add);
  return [...grouped.values()];
}

// 读取并归一化为 { items: [{ standard, description, aliases }] }
function read(deployDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath(deployDir), 'utf8'));
    if (Array.isArray(raw.items)) return { items: normalizeItems(raw.items) };
    if (raw && typeof raw === 'object') {
      const legacyItems = [];
      Object.values(raw).forEach((arr) => {
        if (!Array.isArray(arr)) return;
        legacyItems.push(...arr);
      });
      return { items: normalizeItems(legacyItems) };
    }
  } catch (_) { /* 文件损坏则空表 */ }
  return { items: [] };
}

function write(deployDir, data) {
  const p = filePath(deployDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ items: normalizeItems(data.items) }, null, 2), 'utf8');
  return p;
}

// 全部条目（前端展示用）
function list(deployDir) {
  return read(deployDir).items;
}

// 新增/更新：standard 相同则覆盖别名集合和描述
function upsert(deployDir, aliases, standard, description) {
  const aliasList = cleanAliases(aliases);
  const stdStr = String(standard || '').trim();
  const hasDescription = description !== undefined;
  const descriptionStr = hasDescription ? String(description || '').trim() : '';
  if (!aliasList.length || !stdStr) throw new Error('至少填写一个别名，并填写标准术语');
  const data = read(deployDir);
  const conflicts = data.items
    .filter((item) => item.standard !== stdStr)
    .flatMap((item) => item.aliases.filter((alias) => aliasList.includes(alias)).map((alias) => `${alias}（${item.standard}）`));
  if (conflicts.length) throw new Error(`别名已被其他标准术语使用：${conflicts.join('、')}`);
  const hit = data.items.find((item) => item.standard === stdStr);
  if (hit) {
    hit.aliases = aliasList;
    if (hasDescription) hit.description = descriptionStr;
  } else data.items.push({ standard: stdStr, description: descriptionStr, aliases: aliasList });
  write(deployDir, data);
  return { aliases: aliasList, standard: stdStr, description: hit?.description || descriptionStr, created: !hit };
}

function remove(deployDir, { standard, alias } = {}) {
  const data = read(deployDir);
  const stdStr = String(standard || '').trim();
  const aliasStr = String(alias || '').trim();
  if (stdStr) {
    const next = data.items.filter((item) => item.standard !== stdStr);
    if (next.length === data.items.length) throw new Error('标准术语不存在: ' + stdStr);
    data.items = next;
  } else if (aliasStr) {
    const hit = data.items.find((item) => item.aliases.includes(aliasStr));
    if (!hit) throw new Error('别名不存在: ' + aliasStr);
    hit.aliases = hit.aliases.filter((item) => item !== aliasStr);
    data.items = data.items.filter((item) => item.aliases.length);
  } else {
    throw new Error('standard 必填');
  }
  write(deployDir, data);
  return { removed: stdStr || aliasStr };
}

// 批量导入：兼容 {alias,standard} 与 {aliases,standard}
function bulkImport(deployDir, items) {
  if (!Array.isArray(items) || !items.length) throw new Error('items 不能为空');
  const data = read(deployDir);
  let added = 0, updated = 0;
  normalizeItems(items).forEach((item) => {
    const hit = data.items.find((current) => current.standard === item.standard);
    if (hit) {
      hit.aliases = cleanAliases([...hit.aliases, ...item.aliases]);
      if (item.description) hit.description = item.description;
      updated++;
    }
    else { data.items.push(item); added++; }
  });
  const aliasOwners = new Map();
  data.items.forEach((item) => item.aliases.forEach((alias) => {
    if (aliasOwners.has(alias) && aliasOwners.get(alias) !== item.standard) throw new Error(`别名“${alias}”对应了多个标准术语`);
    aliasOwners.set(alias, item.standard);
  }));
  write(deployDir, data);
  return { added, updated, total: data.items.length };
}

// 覆盖导入：用于业务术语独立迁移；写入前完成标准化和别名唯一性校验。
function replaceAll(deployDir, items) {
  const normalized = normalizeItems(items);
  if (!normalized.length) throw new Error('items 不能为空');
  const aliasOwners = new Map();
  normalized.forEach((item) => item.aliases.forEach((alias) => {
    if (aliasOwners.has(alias) && aliasOwners.get(alias) !== item.standard) {
      throw new Error(`别名“${alias}”对应了多个标准术语`);
    }
    aliasOwners.set(alias, item.standard);
  }));
  write(deployDir, { items: normalized });
  return { total: normalized.length, mode: 'replace' };
}

// 文本解析：返回命中的术语（含精确 + 包含匹配）
function resolveText(deployDir, text) {
  const items = read(deployDir).items;
  const t = String(text || '');
  if (!t) return [];
  return items.flatMap((item) => item.aliases
    .filter((alias) => t === alias || t.includes(alias) || alias.includes(t))
    .map((alias) => ({ alias, standard: item.standard, description: item.description || '' })));
}

// 渲染成 Agent 提示词片段（system prompt 用）
function toPrompt(deployDir) {
  const items = read(deployDir).items;
  const lines = ['【术语归一化规则】查询前，请把用户的口语/简称替换为标准术语：'];
  items.forEach((item) => lines.push(`- ${item.aliases.map((alias) => `"${alias}"`).join(' / ')} → "${item.standard}"${item.description ? `（${item.description}）` : ''}`));
  return lines.join('\n');
}

// 解析 "别名:标准名" 文本行（批量导入 UI 用）
function parseImportLines(text) {
  const out = [];
  String(text || '').split('\n').forEach((line) => {
    const s = line.trim();
    if (!s) return;
    const m = s.match(/^(.+?)[:=：]\s*(.+)$/);
    if (m) out.push({ alias: m[1].trim(), standard: m[2].trim() });
  });
  return out;
}

module.exports = { list, upsert, remove, bulkImport, replaceAll, resolveText, toPrompt, parseImportLines, read, write };
