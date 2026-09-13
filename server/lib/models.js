'use strict';
// schema/*.yml 数据模型文件管理（列表 / 读写 / 模板 / 简易校验）
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

function schemaDir(deployDir) {
  return path.join(deployDir, 'schema');
}

function list(deployDir) {
  const dir = schemaDir(deployDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => {
      const p = path.join(dir, f);
      const s = fs.statSync(p);
      return { name: f, size: s.size, mtime: s.mtime.toISOString() };
    });
}

function validName(name) {
  return /^[A-Za-z0-9_-]+\.ya?ml$/.test(name);
}

function get(deployDir, name) {
  if (!validName(name)) throw new Error('非法文件名');
  const p = path.join(schemaDir(deployDir), name);
  if (!fs.existsSync(p)) throw new Error('文件不存在: ' + name);
  return fs.readFileSync(p, 'utf8');
}

function put(deployDir, name, content) {
  if (!validName(name)) throw new Error('非法文件名');
  if (!content || !content.trim()) throw new Error('内容为空');
  if (!content.includes('cubes:')) throw new Error('YAML 缺少根键 cubes:');
  const dir = schemaDir(deployDir);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  if (fs.existsSync(p)) fs.copyFileSync(p, p + '.bak'); // 写前备份
  fs.writeFileSync(p, content, 'utf8');
  return { name, saved: true, note: '已保存（写前已备份 .bak）。Cube 生产模式不热重载，需重启生效' };
}

function parseYaml(content, label = 'YAML') {
  const doc = YAML.parseDocument(String(content || ''));
  if (doc.errors.length) throw new Error(`${label} 解析失败：${doc.errors.map((error) => error.message).join('; ')}`);
  const value = doc.toJS();
  if (!value || !Array.isArray(value.cubes) || !value.cubes.length) {
    throw new Error(`${label} 缺少 cubes 模型定义`);
  }
  return value;
}

function memberList(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value)
    .filter(([, member]) => member && typeof member === 'object')
    .map(([name, member]) => ({ name, ...member }));
}

// 数据库字段的结构由数据源负责。普通表单/YAML 保存只能修改语义属性，
// 不能新增、删除、改名、改 SQL、改类型或改主键；数据源变更后通过“重建”
// 走 putGenerated，才允许结构随数据库同步。
function assertDimensionStructureUnchanged(existingContent, nextContent) {
  const existing = parseYaml(existingContent, '已有模型');
  const next = parseYaml(nextContent, '待保存模型');
  for (const oldCube of existing.cubes) {
    const nextCube = next.cubes.find((cube) => cube && cube.name === oldCube.name);
    if (!nextCube) throw new Error(`模型 ${oldCube.name} 不允许在表单中删除或改名`);
    const oldDimensions = memberList(oldCube.dimensions);
    const nextDimensions = memberList(nextCube.dimensions);
    if (oldDimensions.length !== nextDimensions.length) {
      throw new Error(`模型 ${oldCube.name} 的维度字段由数据源管理，请先修改数据源后重新建模`);
    }
    for (const oldDimension of oldDimensions) {
      const nextDimension = nextDimensions.find((dimension) => dimension.name === oldDimension.name);
      if (!nextDimension) throw new Error(`字段 ${oldDimension.name} 不允许删除或改名，请先修改数据源后重新建模`);
      const changed = !sameText(oldDimension.sql, nextDimension.sql)
        || String(oldDimension.type || '') !== String(nextDimension.type || '')
        || Boolean(oldDimension.primary_key) !== Boolean(nextDimension.primary_key);
      if (changed) throw new Error(`字段 ${oldDimension.name} 的 SQL、类型和主键属性由数据源管理，请先修改数据源后重新建模`);
    }
  }
}

function sameText(a, b) {
  return String(a || '').trim() === String(b || '').trim();
}

function yamlPairName(pair) {
  return String(pair?.key || '');
}

function markYamlPairSpaceBefore(pair) {
  if (!pair?.key) return;
  if (typeof pair.key === 'string') pair.key = new YAML.Scalar(pair.key);
  pair.key.spaceBefore = true;
}

function officialPreAggregationsPair() {
  const document = YAML.parseDocument(`pre_aggregations:\n  # Pre-aggregation definitions go here.\n  # Learn more in the documentation: https://cube.dev/docs/caching/pre-aggregations/getting-started\n`);
  const pair = document.contents.items[0];
  markYamlPairSpaceBefore(pair);
  return pair;
}

// YAML.stringify(plainObject) 会压缩官方脚手架的空行并丢失预聚合说明。
// 合并已有文档后重新标记官方布局，确保自动建模保存后的 YAML 也与
// Playground 的分段格式一致。
function formatOfficialLayout(content) {
  const document = YAML.parseDocument(String(content || ''));
  if (document.errors.length) return content;
  const cubes = document.get('cubes')?.items || [];
  cubes.forEach((cube) => {
    ['joins', 'dimensions', 'measures'].forEach((section) => {
      const pair = cube.items.find((item) => yamlPairName(item) === section);
      if (!pair) return;
      markYamlPairSpaceBefore(pair);
      if (['dimensions', 'measures'].includes(section) && Array.isArray(pair.value?.items)) {
        pair.value.items.slice(1).forEach((item) => { item.spaceBefore = true; });
      }
    });

    let preAggregations = cube.items.find((item) => yamlPairName(item) === 'pre_aggregations');
    if (!preAggregations || preAggregations.value === null || preAggregations.value?.value === null) {
      const previousPreAggregations = preAggregations;
      preAggregations = officialPreAggregationsPair();
      cube.items = cube.items.filter((item) => item !== previousPreAggregations);
      cube.items.push(preAggregations);
    }
    markYamlPairSpaceBefore(preAggregations);

    const title = cube.items.find((item) => yamlPairName(item) === 'title');
    const description = cube.items.find((item) => yamlPairName(item) === 'description');
    if (title || description) {
      if (title) markYamlPairSpaceBefore(title);
      if (description) markYamlPairSpaceBefore(description);
      cube.items = cube.items.filter((item) => item !== title && item !== description && item !== preAggregations);
      if (title) cube.items.push(title);
      if (description) cube.items.push(description);
      cube.items.push(preAggregations);
    }
  });
  return String(document).replace(/\n+$/, '\n');
}

// 将数据库生成的基础 Cube 与已有文档安全合并：
// - 维度的名称、SQL、类型、主键和集合以数据库生成结果为准；
// - 数据库新增/删除/变更字段会同步到 YAML；
// - 仍存在的字段只保留已有的标题、描述和可见性；
// - 指标、关联及其它 Cube 配置不被自动建模覆盖；
// - 物理表不一致时拒绝写入，防止同名表覆盖错误模型。
function mergeGeneratedContent(existingContent, generatedContent) {
  const existing = parseYaml(existingContent, '已有模型');
  const generated = parseYaml(generatedContent, '生成模型');
  const addedDimensions = [];
  const preservedDimensions = [];
  const addedCubes = [];
  const removedDimensions = [];
  const updatedDimensions = [];

  for (const generatedCube of generated.cubes) {
    const existingCube = existing.cubes.find((cube) => cube && cube.name === generatedCube.name);
    if (!existingCube) {
      existing.cubes.push(generatedCube);
      addedCubes.push(generatedCube.name);
      continue;
    }
    if (existingCube.sql_table && generatedCube.sql_table && !sameText(existingCube.sql_table, generatedCube.sql_table)) {
      throw new Error(`模型 ${generatedCube.name} 已绑定 ${existingCube.sql_table}，不能覆盖为 ${generatedCube.sql_table}`);
    }

    ['sql_table', 'data_source'].forEach((key) => {
      if (existingCube[key] === undefined && generatedCube[key] !== undefined) existingCube[key] = generatedCube[key];
    });
    ['title', 'description'].forEach((key) => {
      if (!existingCube[key] && generatedCube[key]) existingCube[key] = generatedCube[key];
    });

    // Cube YAML 同时支持数组和按名称映射两种写法。统一转成成员列表
    // 后再合并，避免旧模型使用映射写法时被误当成空数组而丢字段。
    const existingDimensions = memberList(existingCube.dimensions);
    const generatedDimensions = memberList(generatedCube.dimensions);
    const existingByName = new Map(existingDimensions.map((dimension) => [dimension?.name, dimension]));
    const generatedNames = new Set(generatedDimensions.map((dimension) => dimension?.name).filter(Boolean));
    existingDimensions.forEach((dimension) => {
      if (dimension?.name && !generatedNames.has(dimension.name)) removedDimensions.push(`${generatedCube.name}.${dimension.name}`);
    });
    existingCube.dimensions = generatedDimensions.map((dimension) => {
      const previous = existingByName.get(dimension.name);
      if (!previous) {
        addedDimensions.push(`${generatedCube.name}.${dimension.name}`);
        return dimension;
      }
      const next = { ...dimension };
      // 这些是允许在配置台维护的语义属性；结构属性保持官方生成结果。
      ['title', 'description', 'public'].forEach((key) => {
        if (previous[key] !== undefined) next[key] = previous[key];
      });
      if (JSON.stringify({ sql: previous.sql, type: previous.type, primary_key: previous.primary_key })
        !== JSON.stringify({ sql: next.sql, type: next.type, primary_key: next.primary_key })) {
        updatedDimensions.push(`${generatedCube.name}.${dimension.name}`);
      }
      preservedDimensions.push(`${generatedCube.name}.${dimension.name}`);
      return next;
    });

    const existingMeasures = memberList(existingCube.measures);
    const measureNames = new Set(existingMeasures.map((measure) => measure?.name).filter(Boolean));
    memberList(generatedCube.measures).forEach((measure) => {
      if (!measureNames.has(measure.name)) existingMeasures.push(measure);
    });
    existingCube.measures = existingMeasures;
  }

  return {
    content: formatOfficialLayout(YAML.stringify(existing, { lineWidth: 0 })),
    changed: JSON.stringify(parseYaml(existingContent)) !== JSON.stringify(existing),
    addedCubes,
    addedDimensions,
    preservedDimensions,
    removedDimensions,
    updatedDimensions,
  };
}

// 自动建模专用写入入口。生成结果先与现有 YAML 合并，再沿用普通模型
// 的 .bak 备份；整个过程只操作 schema/*.yml，不调用 Cube Playground 写盘接口。
function putGenerated(deployDir, name, generatedContent) {
  if (!validName(name)) throw new Error('非法文件名');
  if (!generatedContent || !generatedContent.trim()) throw new Error('生成内容为空');
  parseYaml(generatedContent, '生成模型');
  const p = path.join(schemaDir(deployDir), name);
  const existed = fs.existsSync(p);
  let content = generatedContent;
  let merge = { changed: true, addedCubes: [], addedDimensions: [], preservedDimensions: [], removedDimensions: [], updatedDimensions: [] };
  if (fs.existsSync(p)) {
    merge = mergeGeneratedContent(fs.readFileSync(p, 'utf8'), generatedContent);
    content = merge.content;
  }
  if (!content.includes('cubes:')) throw new Error('YAML 缺少根键 cubes:');
  const dir = schemaDir(deployDir);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (merge.changed || !existed) {
    if (existed) fs.copyFileSync(p, p + '.bak');
    fs.writeFileSync(p, content, 'utf8');
  }
  return {
    name,
    saved: true,
    merged: fs.existsSync(p) && Boolean(merge.addedDimensions.length || merge.preservedDimensions.length || merge.removedDimensions.length || merge.updatedDimensions.length || merge.addedCubes.length),
    changed: merge.changed || !existed,
    addedCubes: merge.addedCubes,
    addedDimensions: merge.addedDimensions,
    preservedDimensions: merge.preservedDimensions,
    removedDimensions: merge.removedDimensions,
    updatedDimensions: merge.updatedDimensions,
    note: '已保存为草稿；字段结构已按数据库同步，已有字段的标题、描述、可见性及指标/关联配置已保留',
  };
}

function createTemplate(name) {
  const safe = String(name || 'new_cube').replace(/\.ya?ml$/i, '').replace(/[^A-Za-z0-9_]/g, '_') || 'new_cube';
  return `cubes:
  - name: ${safe}
    sql_table: <schema>.<table>
    title: ${safe}
    description: 新数据模型
    dimensions:
      - name: id
        sql: id
        type: number
        primary_key: true
    measures:
      - name: count
        type: count
`;
}

// mv 到 deployDir/.cube-trash/（必须在 model/cubes/ 同级，避开 Cube 递归扫描）
function trash(deployDir, name) {
  if (!validName(name)) throw new Error('非法文件名');
  const p = path.join(schemaDir(deployDir), name);
  if (!fs.existsSync(p)) throw new Error('文件不存在: ' + name);
  const trashDir = path.join(deployDir, '.cube-trash');
  if (!fs.existsSync(trashDir)) fs.mkdirSync(trashDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const newName = name.replace(/\.ya?ml$/, '') + '__' + ts + '.yml';
  fs.renameSync(p, path.join(trashDir, newName));
  return { trashed: '.cube-trash/' + newName };
}

module.exports = { list, get, put, putGenerated, mergeGeneratedContent, assertDimensionStructureUnchanged, createTemplate, trash };
