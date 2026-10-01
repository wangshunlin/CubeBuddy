/* Shared by the browser and server: Cube measures remain native YAML objects. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('yaml'));
  else root.CubeMeasures = factory(root.CubeYaml);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (YAML) {
  const types = { count: '记录数', sum: '求和', avg: '平均值', min: '最小值', max: '最大值', count_distinct: '去重计数', number: '计算值' };
  const formats = { '': '默认', currency: '金额', number: '数值', percent: '百分比' };
  function parse(text) { const doc = YAML.parseDocument(text); if (doc.errors.length) throw new Error(doc.errors[0].message); return doc; }
  function validate(measure) {
    if (!measure || typeof measure !== 'object' || Array.isArray(measure)) throw new Error('指标必须是 YAML 对象');
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(measure.name || '')) throw new Error('名称需以字母开头，只能包含字母、数字和下划线');
    if (typeof measure.type !== 'string' || !measure.type) throw new Error('请选择指标类型');
    if (measure.type !== 'count' && !(typeof measure.sql === 'string' && measure.sql.trim()) && !measure.case) throw new Error('此类型需要 SQL 表达式；multi_stage 本身不能替代 SQL');
    if (measure.case && (!measure.multi_stage || typeof measure.case !== 'object' || !measure.case.switch || !Array.isArray(measure.case.when) || !measure.case.else?.sql)) throw new Error('case 指标需要 multi_stage、switch、when 和 else.sql');
    if (measure.sql !== undefined && typeof measure.sql !== 'string') throw new Error('SQL 表达式必须是文本');
    if (measure.filters !== undefined && (!Array.isArray(measure.filters) || measure.filters.some(f => !f || typeof f.sql !== 'string' || !f.sql.trim()))) throw new Error('每条固定条件必须包含非空 SQL');
    return measure;
  }
  function expressionConfig(type) {
    if (type === 'count') return { label: '计数表达式（可选）', hint: 'SQL 可留空，Cube 将统计记录数。填写时需按实际查询验证计数口径。', placeholder: '可留空' };
    if (type === 'number') return { label: '聚合表达式 / 指标公式', hint: '引用已聚合指标，或填写聚合 SQL。比率建议使用 NULLIF 处理零分母。', placeholder: '1.0 * {paid_revenue} / NULLIF({paid_order_count}, 0)' };
    const labels = { sum: '求和', avg: '平均', min: '最小值', max: '最大值', count_distinct: '去重' };
    return { label: labels[type] ? `${labels[type]}字段 / 表达式` : 'SQL 表达式', hint: labels[type] ? '填写行级字段或表达式；Cube 会添加对应聚合。此处通常不需要 SUM、AVG 等聚合函数。' : '高级类型按原始定义保留，请使用实际 Cube 版本编译确认表达式。', placeholder: type === 'count_distinct' ? '例如 customer_id' : '例如 amount' };
  }
  function insertReference(text, selection, reference) {
    const start = Math.min(text.length, Math.max(0, selection?.start ?? text.length));
    const end = Math.min(text.length, Math.max(start, selection?.end ?? start));
    const before = text.slice(0, start), after = text.slice(end);
    const leftAdjacent = /[\w}.]$/.test(before), rightAdjacent = /^[\w{.]/.test(after);
    const prefix = leftAdjacent ? ' ' : '', suffix = rightAdjacent ? ' ' : '';
    return { value: before + prefix + reference + suffix + after, start: start + prefix.length, end: start + prefix.length + reference.length, adjacent: leftAdjacent || rightAdjacent };
  }
  function validateNames(document) {
    for (const cube of document.cubes || []) {
      const used = new Map();
      for (const section of ['dimensions', 'measures', 'segments']) {
        const members = Array.isArray(cube[section]) ? cube[section] : Object.entries(cube[section] || {}).map(([name, member]) => ({ name, ...member }));
        for (const member of members) {
          if (used.has(member.name)) throw new Error(`成员名称冲突：${cube.name}.${member.name}（${used.get(member.name)} / ${section}）`);
          used.set(member.name, section);
        }
      }
    }
  }
  function references(value, cube, name) {
    const text = YAML.stringify(value);
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const qualified = cube.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\{(?:${qualified}\\.|CUBE\\.)?${escaped}\\}`).test(text);
  }
  function dependencies(document, cubeName, name) {
    const result = [];
    for (const cube of document.cubes || []) {
      for (const section of ['measures', 'dimensions', 'segments', 'pre_aggregations']) {
        const entries = Array.isArray(cube[section]) ? cube[section] : Object.entries(cube[section] || {}).map(([name, value]) => ({ name, ...value }));
        for (const member of entries) {
          if (section === 'measures' && cube.name === cubeName && member.name === name) continue;
          // Unqualified references are scoped to the current cube.
          const hit = cube.name === cubeName ? references(member, cubeName, name) : YAML.stringify(member).includes(`{${cubeName}.${name}}`);
          const rollupHit = section === 'pre_aggregations' && (member.measures || []).some(m => m === `${cubeName}.${name}` || (cube.name === cubeName && m === name));
          if (hit || rollupHit) result.push(`${cube.name}.${member.name || section}`);
        }
      }
    }
    for (const view of document.views || []) for (const c of view.cubes || []) {
      if (String(c.join_path || '').split('.').includes(cubeName) && (c.includes === '*' || (c.includes || []).some(m => (typeof m === 'string' ? m : m.name) === name))) result.push(`View ${view.name}`);
    }
    return [...new Set(result)];
  }
  function validateGraph(document) {
    validateNames(document);
    const graph = new Map(), known = new Set();
    for (const cube of document.cubes || []) {
      for (const section of ['measures', 'dimensions']) {
        const entries = Array.isArray(cube[section]) ? cube[section] : Object.entries(cube[section] || {}).map(([name, value]) => ({ name, ...value }));
        for (const member of entries) known.add(`${cube.name}.${member.name}`);
      }
    }
    for (const cube of document.cubes || []) {
      const measures = Array.isArray(cube.measures) ? cube.measures : Object.entries(cube.measures || {}).map(([name, value]) => ({ name, ...value }));
      for (const measure of measures) {
        const key = `${cube.name}.${measure.name}`, refs = [];
        const expressions = [measure.sql, ...(measure.filters || []).map(f => f.sql)].filter(v => typeof v === 'string');
        for (const expression of expressions) for (const match of expression.matchAll(/\{([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)?)\}/g)) {
          const ref = match[1];
          if (ref === 'CUBE' || (document.cubes || []).some(c => c.name === ref)) continue;
          const qualified = ref.includes('.') ? ref.replace(/^CUBE\./, `${cube.name}.`) : `${cube.name}.${ref}`;
          const targetCube = qualified.split('.')[0];
          if (!known.has(qualified) && (document.cubes || []).some(c => c.name === targetCube && !c.extends) && !cube.extends) throw new Error(`指标 ${key} 引用了不存在的成员：${ref}`);
          refs.push(qualified);
        }
        graph.set(key, refs);
      }
    }
    const visiting = new Set(), visited = new Set();
    function visit(key) {
      if (visiting.has(key)) throw new Error(`指标循环引用：${key}`);
      if (visited.has(key) || !graph.has(key)) return;
      visiting.add(key); for (const dep of graph.get(key)) visit(dep); visiting.delete(key); visited.add(key);
    }
    for (const key of graph.keys()) visit(key);
  }
  function patch(content, cubeName, items) {
    const doc = parse(content), cubes = doc.get('cubes');
    const cube = cubes?.items?.find(c => c.get('name') === cubeName);
    if (!cube) throw new Error(`模型 ${cubeName} 不存在`);
    const old = cube.get('measures');
    const oldEntries = YAML.isSeq(old) ? old.items : YAML.isMap(old) ? old.items.map(p => { const node = p.value.clone(); node.set('name', String(p.key)); return node; }) : [];
    const names = new Set();
    for (const item of items) { validate(item); if (names.has(item.name)) throw new Error(`指标名称重复：${item.name}`); names.add(item.name); }
    const previous = doc.toJS();
    for (const node of oldEntries) {
      const name = node.get('name');
      if (!names.has(name)) { const deps = dependencies(previous, cubeName, name); if (deps.length) throw new Error(`指标 ${name} 被引用：${deps.join('、')}。请先处理依赖。`); }
    }
    const next = old && YAML.isSeq(old) ? old.clone() : doc.createNode([]);
    next.items = items.map(item => {
      const base = oldEntries.find(n => n.get('name') === (item._originalName || item.name));
      const node = base ? base.clone() : doc.createNode({});
      const value = { ...item }; delete value._originalName;
      for (const pair of [...node.items]) if (!(String(pair.key) in value)) node.delete(String(pair.key));
      for (const [key, val] of Object.entries(value)) if (val !== undefined && JSON.stringify(node.get(key, true)?.toJSON?.() ?? node.get(key)) !== JSON.stringify(val)) node.set(key, doc.createNode(val));
      return node;
    });
    cube.set('measures', next);
    validateGraph(doc.toJS());
    return String(doc);
  }
  function fromUi(item) {
    const result = { ...(item._raw || {}), name: item.name, type: item.type };
    for (const key of ['title', 'description', 'format', 'currency']) { if (item[key] && item[key] !== '默认') result[key] = item[key]; else if (item[key] !== undefined) delete result[key]; }
    if (item.sql && item.sql !== '—') result.sql = item.sql; else delete result.sql;
    if (item.public === false) result.public = false; else if (typeof item.public === 'string') result.public = item.public; else if (typeof result.public !== 'string') delete result.public;
    if (item.filters?.length) result.filters = item.filters; else delete result.filters;
    if (item._originalName) result._originalName = item._originalName;
    return result;
  }
  return { types, formats, parse, validate, validateNames, expressionConfig, insertReference, validateGraph, patch, dependencies, fromUi, stringify: value => YAML.stringify(value, { lineWidth: 0 }) };
});
