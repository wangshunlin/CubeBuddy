import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ds = require('../../server/lib/datasources.js');
const YAML = require('yaml');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-rename-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'schema'));
  fs.writeFileSync(path.join(dir, 'datasources.json'), JSON.stringify({sources:[{name:'default',type:'mysql',password:'kept-password',database:'sales'}]}));
  return dir;
}
test('default rename migrates implicit and explicit model bindings, retains password and runtime default alias', t => {
  const dir = fixture(t);
  const file = path.join(dir,'schema','orders.yml');
  const original = 'cubes:\n  - name: orders\n    sql_table: sales.order_records\n  - name: payments\n    data_source: default\n  - name: unrelated\n    data_source: other\n';
  fs.writeFileSync(file, original);
  ds.upsert(dir, {oldName:'default',name:'sales_db',type:'mysql',database:'sales'});
  const cubes = YAML.parse(fs.readFileSync(file,'utf8')).cubes;
  assert.deepEqual(cubes.map(c=>c.data_source), ['sales_db','sales_db','other']);
  assert.equal(cubes[0].sql_table,'sales.order_records');
  assert.equal(fs.readFileSync(file+'.bak','utf8'),original);
  assert.equal(ds.read(dir)[0].password,'kept-password');
  assert.equal(ds.buildEnv(dir).CUBEJS_DATASOURCES,'default,sales_db');
});
test('invalid model YAML prevents source rename and leaves earlier files untouched', t => {
  const dir = fixture(t);
  const first = path.join(dir,'schema','a.yml');
  const original = 'cubes:\n  - name: orders\n';
  fs.writeFileSync(first,original);
  fs.writeFileSync(path.join(dir,'schema','z.yml'),'cubes: [');
  assert.throws(()=>ds.upsert(dir,{oldName:'default',name:'sales_db'}),/YAML 无效/);
  assert.equal(ds.read(dir)[0].name,'default');
  assert.equal(fs.readFileSync(first,'utf8'),original);
});
test('Chinese display name preserves default identifier, model bindings and database password', t => {
  const dir = fixture(t);
  const file = path.join(dir,'schema','orders.yml');
  const original = 'cubes:\n  - name: orders\n    data_source: default\n';
  fs.writeFileSync(file,original);
  const result = ds.upsert(dir,{name:'default',oldName:'default',displayName:'业务数据源（华南）',type:'mysql',database:'sales'});
  assert.equal(result.connectionChanged,false);
  assert.equal(ds.read(dir)[0].displayName,'业务数据源（华南）');
  assert.equal(ds.read(dir)[0].name,'default');
  assert.equal(ds.read(dir)[0].password,'kept-password');
  assert.equal(fs.readFileSync(file,'utf8'),original);
  assert.equal(ds.buildEnv(dir).CUBEJS_DATASOURCES,'default');
});
test('an already open legacy edit dialog can submit a Chinese label without renaming default', t => {
  const dir = fixture(t);
  ds.upsert(dir,{name:'中文数据源',oldName:'default',type:'mysql',database:'sales'});
  assert.equal(ds.read(dir)[0].name,'default');
  assert.equal(ds.read(dir)[0].displayName,'中文数据源');
});
test('MySQL default database is optional and cleared database is removed from runtime env', t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir,'.env'),'CUBEJS_DB_NAME=sales\n');
  ds.upsert(dir,{name:'default',type:'mysql',database:''});
  assert.equal(ds.read(dir)[0].database,'');
  assert.equal(ds.buildEnv(dir).CUBEJS_DB_NAME,undefined);
});
test('PostgreSQL requires a connection database before persisting changes', t => {
  const dir = fixture(t);
  assert.throws(()=>ds.upsert(dir,{name:'default',type:'postgres',database:''}),/PostgreSQL 连接数据库/);
  assert.equal(ds.read(dir)[0].type,'mysql');
});
