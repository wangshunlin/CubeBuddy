import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipSync, strToU8, unzipSync } from 'fflate';
import transfer from '../../server/lib/model-transfer.js';
import servers from '../../server/lib/mcp-servers.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-transfer-'));
  fs.mkdirSync(path.join(dir, 'schema'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const yaml = (id, title = id) => `cubes:\n  - name: ${id}\n    title: ${title}\n    sql_table: test.${id}\n    measures:\n      - name: count\n        type: count\n`;
const upload = (content, name = 'models.yml') => ({ name, data: Buffer.from(content).toString('base64') });

test('export selects individual cubes from a multi-cube file and ZIP round-trips', t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, 'schema', 'bundle.yml'), 'cubes:\n  - name: orders\n    title: 订单\n    data_source: sales\n  - name: finance\n');
  const zip = transfer.exportZip(dir, ['orders']);
  const files = unzipSync(zip);
  const manifest = JSON.parse(Buffer.from(files['manifest.json']));
  assert.deepEqual(manifest.models.map(item => item.id), ['orders']);
  const preview = transfer.preview(dir, upload(zip, 'models.zip'));
  assert.equal(preview.entries[0].source, 'sales');
  assert.equal(preview.entries[0].conflict, true);
  assert.deepEqual(preview.removed.map(item => item.id), ['finance']);
});

test('merge preserves local conflicts and overwrites selected IDs even with different filenames', t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, 'schema', 'bundle.yml'), 'cubes:\n  - name: orders\n    title: Old\n  - name: finance\n');
  const file = upload(yaml('orders', 'New'));
  let p = transfer.preview(dir, file);
  assert.equal(transfer.importModels(dir, { upload: file, mode: 'merge', revision: p.revision }).imported, 0);
  p = transfer.preview(dir, file);
  const result = transfer.importModels(dir, { upload: file, mode: 'merge', revision: p.revision, overwriteIds: ['orders'] });
  assert.equal(result.imported, 1);
  assert.deepEqual(transfer.catalog(dir).map(item => item.id).sort(), ['finance', 'orders']);
  assert.equal(transfer.catalog(dir).find(item => item.id === 'orders').title, 'New');
  assert.ok(fs.existsSync(path.join(dir, result.backup, 'schema', 'bundle.yml')));
});

test('replace requires confirmation, snapshots before removal and queues drafts', t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, 'schema', 'old.yml'), yaml('old'));
  const file = upload(yaml('new_model'));
  const p = transfer.preview(dir, file);
  assert.throws(() => transfer.importModels(dir, { upload: file, mode: 'replace', revision: p.revision }), /确认/);
  const result = transfer.importModels(dir, { upload: file, mode: 'replace', revision: p.revision, confirmReplace: '全量覆盖' });
  assert.equal(result.removed, 1);
  assert.deepEqual(transfer.catalog(dir).map(item => item.id), ['new_model']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.cube-console-state.json'))).pendingModels, ['new_model.yml']);
  assert.ok(fs.existsSync(path.join(dir, result.backup, 'schema', 'old.yml')));
});

test('stale previews and invalid archives never mutate models', t => {
  const dir = fixture(t);
  const file = upload(yaml('new_model'));
  const p = transfer.preview(dir, file);
  fs.writeFileSync(path.join(dir, 'schema', 'other.yml'), yaml('other'));
  assert.throws(() => transfer.importModels(dir, { upload: file, mode: 'merge', revision: p.revision }), /重新预览/);
  const traversal = zipSync({ '../escape.yml': strToU8(yaml('escape')) });
  assert.throws(() => transfer.preview(dir, upload(traversal, 'bad.zip')), /路径/);
  assert.throws(() => transfer.preview(dir, upload('cubes:\n - name: x\n - name: x\n')), /重复/);
  assert.throws(() => transfer.preview(dir, upload(zipSync({ 'large.yml': new Uint8Array(11 * 1024 * 1024) }), 'large.zip')), /10 MB/);
  assert.deepEqual(transfer.catalog(dir).map(item => item.id), ['other']);
});

test('failed state write rolls model files back to their exact originals', t => {
  const dir = fixture(t);
  const original = yaml('old');
  fs.writeFileSync(path.join(dir, 'schema', 'old.yml'), original);
  const file = upload(yaml('new_model'));
  const p = transfer.preview(dir, file);
  const write = fs.writeFileSync;
  fs.writeFileSync = function (target, ...args) {
    if (target === path.join(dir, '.cube-console-state.json')) throw new Error('simulated disk failure');
    return write.call(this, target, ...args);
  };
  try { assert.throws(() => transfer.importModels(dir, { upload: file, mode: 'replace', revision: p.revision, confirmReplace: '全量覆盖' }), /disk failure/); }
  finally { fs.writeFileSync = write; }
  assert.equal(fs.readFileSync(path.join(dir, 'schema', 'old.yml'), 'utf8'), original);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'schema')), ['old.yml']);
});

test('default MCP deletion persists and a different server can become the only default', t => {
  const dir = fixture(t);
  servers.ensureDefault(dir, ['orders']);
  servers.remove(dir, 'default');
  assert.deepEqual(servers.ensureDefault(dir, ['orders']).servers, []);
  servers.create(dir, { id: 'sales', modelIds: ['orders'], isDefault: true }, ['orders']);
  servers.create(dir, { id: 'other', modelIds: ['orders'], isDefault: true }, ['orders']);
  assert.deepEqual(servers.read(dir).servers.filter(item => item.isDefault).map(item => item.id), ['other']);
  servers.update(dir, 'other', { isDefault: false }, ['orders']);
  assert.equal(servers.read(dir).servers.some(item => item.isDefault), false);
});

test('detaching a deleted model removes every MCP binding and disables empty servers', t => {
  const dir = fixture(t);
  servers.write(dir, [
    { id: 'default', isDefault: true, modelIds: ['orders', 'finance'] },
    { id: 'orders-only', modelIds: ['orders'] },
    { id: 'finance-only', modelIds: ['finance'] },
  ]);
  const preview = servers.modelBindings(dir, ['orders']);
  assert.deepEqual(preview.map(item => item.id), ['default', 'orders-only']);
  const affected = servers.detachModels(dir, ['orders']);
  assert.deepEqual(affected.map(item => ({ id: item.id, disabled: item.disabled })), [
    { id: 'default', disabled: false }, { id: 'orders-only', disabled: true },
  ]);
  const after = new Map(servers.read(dir).servers.map(item => [item.id, item]));
  assert.deepEqual(after.get('default').modelIds, ['finance']);
  assert.equal(after.get('orders-only').enabled, false);
  assert.deepEqual(after.get('orders-only').modelIds, []);
  assert.deepEqual(after.get('finance-only').modelIds, ['finance']);
});
