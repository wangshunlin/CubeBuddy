import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const M = require('../../public/measures.js');
const source = `# model comment
cubes:
  - name: orders
    sql_table: orders
    joins:
      - name: users
        sql: "{CUBE}.user_id = {users}.id AND {users}.active = true"
        relationship: many_to_one
    measures:
      # revenue comment
      - name: revenue
        type: sum
        sql: amount
        format: currency
        meta:
          labels: [finance, certified]
        filters:
          - sql: "{CUBE}.status = 'paid'"
      - name: count
        type: count
      - name: aov
        type: number
        sql: "1.0 * {revenue} / NULLIF({count}, 0)"
  - name: other
    sql_table: other
    measures:
      - name: count
        type: count
`;
test('measure edits preserve comments, nested metadata, joins and other cubes', () => {
  const before = M.parse(source).toJS();
  const items = before.cubes[0].measures.map(m => ({ ...m }));
  items[0].title = '已支付金额'; items[0].type = 'avg'; items[0].format = 'number';
  const text = M.patch(source, 'orders', items), after = M.parse(text).toJS();
  assert.match(text, /# revenue comment/);
  assert.match(text, /# model comment/);
  assert.deepEqual(after.cubes[0].joins, before.cubes[0].joins);
  assert.deepEqual(after.cubes[1], before.cubes[1]);
  assert.deepEqual(after.cubes[0].measures[0].meta, before.cubes[0].measures[0].meta);
  assert.deepEqual(after.cubes[0].measures[0].filters, before.cubes[0].measures[0].filters);
  assert.equal(after.cubes[0].measures[0].type, 'avg');
  assert.equal(after.cubes[0].measures[0].format, 'number');
});
test('count allows omitted SQL; invalid conditions and duplicates are rejected', () => {
  assert.doesNotThrow(() => M.validate({ name: 'count', type: 'count' }));
  assert.throws(() => M.validate({ name: 'total', type: 'sum' }), /SQL/);
  assert.throws(() => M.validate({ name: 'count', type: 'count', filters: [{ sql: '' }] }), /固定条件/);
  assert.throws(() => M.patch(source, 'other', [{ name: 'count', type: 'count' }, { name: 'count', type: 'count' }]), /重复/);
});
test('deleting or renaming a referenced measure is blocked atomically', () => {
  const items = M.parse(source).toJS().cubes[0].measures;
  assert.throws(() => M.patch(source, 'orders', items.filter(m => m.name !== 'revenue')), /aov/);
  assert.throws(() => M.patch(source, 'orders', items.map(m => m.name === 'revenue' ? { ...m, name: 'new_revenue', _originalName: 'revenue' } : m)), /aov/);
});
test('mapped measure definitions and YAML advanced arrays remain native', () => {
  const text = 'cubes:\n  - name: orders\n    measures:\n      count:\n        type: count\n        drill_members: [id, created_at]\n';
  const patched = M.patch(text, 'orders', [{ name: 'count', type: 'count', drill_members: ['id', 'created_at'], title: '订单数' }]);
  assert.deepEqual(M.parse(patched).toJS().cubes[0].measures[0].drill_members, ['id', 'created_at']);
});
test('unresolved members and cyclic calculations are rejected', () => {
  assert.throws(() => M.patch(source, 'other', [{ name: 'bad', type: 'number', sql: '{missing} * 2' }]), /不存在/);
  assert.throws(() => M.patch(source, 'other', [{ name: 'a', type: 'number', sql: '{b}' }, { name: 'b', type: 'number', sql: '{a}' }]), /循环引用/);
});
test('member names cannot collide with dimensions or segments', () => {
  assert.throws(() => M.validateNames({ cubes: [{ name: 'orders', dimensions: [{name:'status'}], measures: [{name:'status',type:'count'}] }] }), /名称冲突/);
  assert.throws(() => M.validateNames({ cubes: [{ name: 'orders', segments: { paid: { sql: "status = 'paid'" } }, measures: [{name:'paid',type:'count'}] }] }), /名称冲突/);
});
test('multi_stage alone does not waive SQL; valid case definitions do', () => {
  assert.throws(() => M.validate({name:'ratio',type:'number',multi_stage:true}), /不能替代/);
  assert.doesNotThrow(() => M.validate({name:'conditional',type:'number',multi_stage:true,case:{switch:'{currency}',when:[{value:'USD',sql:'{usd}'}],else:{sql:'{eur}'}}}));
});
test('reference insertion replaces a selection and separates adjacent expressions', () => {
  assert.deepEqual(M.insertReference('amount', {start:6,end:6}, '{CUBE}.status'), { value:'amount {CUBE}.status', start:7, end:20, adjacent:true });
  assert.equal(M.insertReference('amount / 2', {start:0,end:6}, '{revenue}').value, '{revenue} / 2');
  assert.equal(M.insertReference(' + 2', {start:0,end:0}, '{count}').value, '{count} + 2');
});
test('editing preserves hidden currency and private / advanced definitions', () => {
  const raw={name:'revenue',type:'sum',sql:'amount',public:false,currency:'CNY',format:'currency',rolling_window:{trailing:'7 day'}};
  const updated=M.fromUi({...raw,_raw:raw,title:'收入'});
  assert.equal(updated.public,false);
  assert.equal(updated.currency,'CNY');
  assert.deepEqual(updated.rolling_window,{trailing:'7 day'});
});
