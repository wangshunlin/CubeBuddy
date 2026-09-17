'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const YAML = require('yaml');
const { zipSync, unzipSync, strToU8, strFromU8 } = require('fflate');
const models = require('./models');
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_MODELS = 500;

function parseFiles(files) {
  const entries = [];
  const ids = new Set();
  for (const file of files) {
    const doc = YAML.parseDocument(file.content);
    if (doc.errors.length) throw new Error(`${file.name}：${doc.errors[0].message}`);
    const value = doc.toJS({ maxAliasCount: 100 });
    if (!Array.isArray(value?.cubes) || !value.cubes.length) throw new Error(`${file.name} 缺少 cubes 定义`);
    // 仅迁移 Cube 模型，不能静默丢弃文件中的 views 等其他根定义。
    if (Object.keys(value).some((key) => key !== 'cubes')) throw new Error(`${file.name} 包含 cubes 以外的根定义，请拆分后导入导出`);
    value.cubes.forEach((cube, index) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(cube?.name || '')) throw new Error(`${file.name} 模型名称无效`);
      if (ids.has(cube.name)) throw new Error(`模型 ID 重复：${cube.name}`);
      ids.add(cube.name);
      const single = doc.clone();
      single.get('cubes').items = [single.get('cubes').items[index]];
      // 跨 Cube YAML anchor 在拆分后无法保留时使用已解析的值。
      let content = String(single);
      try { YAML.parse(content); } catch (_) { content = YAML.stringify({ cubes: [cube] }); }
      entries.push({ id: cube.name, title: String(cube.title || cube.name), source: String(cube.data_source || 'default'), filename: file.name, content });
    });
  }
  if (entries.length > MAX_MODELS) throw new Error(`最多支持 ${MAX_MODELS} 个模型`);
  return entries;
}

function current(dir) {
  return models.list(dir).sort((a, b) => a.name.localeCompare(b.name)).map(({ name }) => ({ name, content: models.get(dir, name) }));
}
function fingerprint(files) { return crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex'); }
function catalog(dir) { return parseFiles(current(dir)).map(({ content, ...entry }) => entry); }

function decodeUpload(upload) {
  if (!upload || typeof upload.data !== 'string' || upload.data.length > Math.ceil(MAX_BYTES * 4 / 3) + 4) throw new Error('文件大小不得超过 10 MB');
  const bytes = Buffer.from(upload.data, 'base64');
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('文件为空或超过 10 MB');
  if (/\.ya?ml$/i.test(upload.name || '')) return parseFiles([{ name: upload.name, content: bytes.toString('utf8') }]);
  if (!/\.zip$/i.test(upload.name || '')) throw new Error('请选择 YAML 或 ZIP 文件');
  let total = 0; let count = 0;
  const files = unzipSync(bytes, { filter(entry) {
    if (++count > MAX_MODELS + 1) throw new Error('压缩包文件数量过多');
    if (!/^(?:models\/)?[A-Za-z0-9_-]+\.ya?ml$/.test(entry.name) && entry.name !== 'manifest.json') throw new Error(`压缩包包含不支持的路径：${entry.name}`);
    total += entry.originalSize;
    if (total > MAX_BYTES || !Number.isFinite(total)) throw new Error('解压后不得超过 10 MB');
    return true;
  } });
  if (files['manifest.json']) {
    const manifest = JSON.parse(strFromU8(files['manifest.json']));
    if (manifest.format !== 'cubebuddy-models' || manifest.version !== 1) throw new Error('不支持的模型包版本');
  }
  const entries = parseFiles(Object.entries(files).filter(([name]) => /\.ya?ml$/.test(name)).map(([name, data]) => ({ name, content: strFromU8(data) })));
  if (!entries.length) throw new Error('压缩包没有模型');
  return entries;
}

function exportZip(dir, ids) {
  if (!Array.isArray(ids) || !ids.length) throw new Error('请至少选择一个模型');
  const all = parseFiles(current(dir));
  const selected = [...new Set(ids)].map((id) => {
    const entry = all.find((item) => item.id === id);
    if (!entry) throw new Error(`模型不存在：${id}`);
    return entry;
  });
  const archive = Object.create(null);
  const manifest = { format: 'cubebuddy-models', version: 1, exportedAt: new Date().toISOString(), models: [] };
  selected.forEach(({ content, ...entry }) => {
    const filename = `models/${entry.id}.yml`;
    archive[filename] = strToU8(content);
    manifest.models.push({ ...entry, filename });
  });
  archive['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));
  return Buffer.from(zipSync(archive));
}

function preview(dir, upload) {
  const files = current(dir);
  const existing = parseFiles(files);
  const incoming = decodeUpload(upload);
  const incomingIds = new Set(incoming.map((entry) => entry.id));
  return {
    revision: fingerprint(files),
    entries: incoming.map(({ content, ...entry }) => ({ ...entry, conflict: existing.some((item) => item.id === entry.id) })),
    removed: existing.filter((entry) => !incomingIds.has(entry.id)).map(({ content, ...entry }) => entry),
    existingCount: existing.length,
  };
}

function importModels(dir, { upload, mode, overwriteIds = [], revision, confirmReplace }) {
  if (!['merge', 'replace'].includes(mode)) throw new Error('请选择增量导入或全量覆盖');
  if (mode === 'replace' && confirmReplace !== '全量覆盖') throw new Error('请输入“全量覆盖”确认');
  const before = current(dir);
  if (revision !== fingerprint(before)) throw new Error('模型已发生变化，请重新预览后导入');
  const incoming = decodeUpload(upload);
  const existing = parseFiles(before);
  const ids = new Set(existing.map((entry) => entry.id));
  if (!Array.isArray(overwriteIds) || overwriteIds.some((id) => !incoming.some((entry) => entry.id === id))) throw new Error('冲突选择无效');
  const selected = incoming.filter((entry) => mode === 'replace' || !ids.has(entry.id) || overwriteIds.includes(entry.id));
  if (!selected.length) return { imported: 0, skipped: incoming.length, removed: 0, backup: null };
  const replaced = new Set(selected.map((entry) => entry.id));
  const after = new Map();
  if (mode === 'merge') {
    for (const file of before) {
      const doc = YAML.parseDocument(file.content);
      const cubes = doc.get('cubes');
      const remaining = cubes.items.filter((cube) => !replaced.has(String(cube.get('name'))));
      if (remaining.length === cubes.items.length) after.set(file.name, file.content);
      else if (remaining.length) { cubes.items = remaining; after.set(file.name, String(doc)); }
    }
  }
  for (const entry of selected) {
    let name = `${entry.id}.yml`; let suffix = 1;
    while (after.has(name)) name = `${entry.id}_${suffix++}.yml`;
    after.set(name, entry.content);
  }
  // 校验整个结果，防止部分文件更新后才发现冲突或损坏。
  parseFiles([...after].map(([name, content]) => ({ name, content })));
  const schema = path.join(dir, 'schema');
  const statePath = path.join(dir, '.cube-console-state.json');
  const stateBefore = fs.existsSync(statePath) ? fs.readFileSync(statePath) : null;
  const state = stateBefore ? JSON.parse(stateBefore) : {};
  const backup = path.join('.model-import-backups', `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
  const backupDir = path.join(dir, backup);
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  if (fs.existsSync(schema)) fs.cpSync(schema, path.join(backupDir, 'schema'), { recursive: true });
  if (stateBefore) fs.writeFileSync(path.join(backupDir, 'console-state.json'), stateBefore);
  fs.mkdirSync(schema, { recursive: true });
  try {
    for (const [name, content] of after) fs.writeFileSync(path.join(schema, name), content);
    for (const { name } of before) if (!after.has(name)) fs.unlinkSync(path.join(schema, name));
    const changed = [...after].filter(([name, content]) => before.find((file) => file.name === name)?.content !== content).map(([name]) => name);
    // 全量覆盖始终入队，以便只有删除、没有内容变更时也能发布。
    const pendingModels = mode === 'replace' ? [...after.keys()] : [...new Set([...(state.pendingModels || []).filter((name) => after.has(name)), ...changed])];
    fs.writeFileSync(statePath, JSON.stringify({ ...state, pendingModels, loadedModels: (state.loadedModels || []).filter((id) => !replaced.has(id) && (mode !== 'replace' || incoming.some((entry) => entry.id === id))) }, null, 2));
  } catch (error) {
    for (const name of after.keys()) if (!before.some((file) => file.name === name)) fs.rmSync(path.join(schema, name), { force: true });
    for (const file of before) fs.writeFileSync(path.join(schema, file.name), file.content);
    if (stateBefore) fs.writeFileSync(statePath, stateBefore); else fs.rmSync(statePath, { force: true });
    throw error;
  }
  return { imported: selected.length, skipped: incoming.length - selected.length, removed: mode === 'replace' ? existing.filter((entry) => !replaced.has(entry.id)).length : 0, backup };
}

module.exports = { catalog, exportZip, preview, importModels };
