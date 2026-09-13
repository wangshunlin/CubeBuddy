'use strict';
// 数据库 introspection（支持跨库多表 + 多数据源）
// 连接方式：数据源配了 container 用 docker exec 进容器执行；外部 MySQL 使用 mysql2，PostgreSQL 使用 psql 客户端
// 读取 information_schema 生成 Cube YAML 模型（自动带 data_source）
const { run } = require('./run');
const datasources = require('./datasources');
const mysql = require('mysql2/promise');
const YAML = require('yaml');
const { ScaffoldingTemplate, SchemaFormat } = require('@cubejs-backend/schema-compiler');

function quoteIdentifier(ds, value) {
  const text = String(value || '');
  if (isPostgres(ds)) return `"${text.replace(/"/g, '""')}"`;
  return `\`${text.replace(/`/g, '``')}\``;
}

function normalizedMemberKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// 使用 Cube 官方 ScaffoldingTemplate 生成初始模型。这个函数只构造并返回
// YAML 文档，不读写 schema 目录，也不调用 Playground 的 /playground/
// generate-schema（该接口会清空并重写 cubes/views 目录）。
function buildCubeScaffold({ ds, db, table, columns, tableComment }) {
  const dbSchema = {
    [db]: {
      [table]: columns.map((column) => ({
        name: column.name,
        type: column.type,
        ...(column.primaryKey ? { attributes: ['primaryKey'] } : {}),
      })),
    },
  };
  const driver = { quoteIdentifier: (value) => quoteIdentifier(ds, value) };
  const template = new ScaffoldingTemplate(dbSchema, driver, {
    format: SchemaFormat.Yaml,
    // 保持当前系统使用的 sql_table/data_source 命名，同时让字段名保持
    // 数据库的 snake_case 兼容规则，避免生成 camelCase Cube 成员。
    snakeCase: true,
  });
  const tableName = `${db}.${table}`;
  const context = ds.name !== 'default' ? { dataSource: ds.name } : {};
  const files = template.generateFilesByTableNames([tableName], context);
  if (!files.length || !files[0].content) throw new Error(`Cube 官方脚手架未生成模型：${tableName}`);
  // 以官方 Playground 返回的 Document 为基础直接修改节点。若先转成
  // 普通对象再 YAML.stringify，会丢失官方保留的空行和 pre_aggregations
  // 注释。
  const document = YAML.parseDocument(files[0].content);
  const cube = document.get('cubes')?.items?.[0];
  if (!cube) throw new Error(`Cube 官方脚手架未生成模型：${tableName}`);

  const comments = new Map(columns
    .filter((column) => column.comment)
    .map((column) => [normalizedMemberKey(column.name), column.comment]));
  const dimensions = cube.get('dimensions')?.items || [];
  dimensions.forEach((dimension) => {
    const name = dimension.get('name');
    const comment = comments.get(normalizedMemberKey(name));
    if (comment && !dimension.get('description')) dimension.set('description', comment);
  });

  // 业务标题和描述仍由配置台补充，但插入到官方预聚合注释之前，保持
  // Playground 的分段空行布局。
  cube.set('title', tableComment || table);
  cube.set('description', tableComment || `由 Cube 官方脚手架从数据库表 ${db}.${table} 自动生成`);
  const pairName = (pair) => String(pair?.key || '');
  const titlePair = cube.items.find((pair) => pairName(pair) === 'title');
  const descriptionPair = cube.items.find((pair) => pairName(pair) === 'description');
  if (titlePair?.key) {
    titlePair.key = new YAML.Scalar(String(titlePair.key));
    titlePair.key.spaceBefore = true;
  }
  if (descriptionPair?.key) {
    descriptionPair.key = new YAML.Scalar(String(descriptionPair.key));
    descriptionPair.key.spaceBefore = true;
  }
  cube.items = cube.items.filter((pair) => pair !== titlePair && pair !== descriptionPair);
  const insertAt = cube.items.findIndex((pair) => pairName(pair) === 'pre_aggregations');
  cube.items.splice(insertAt >= 0 ? insertAt : cube.items.length, 0, titlePair, descriptionPair);
  return String(document).replace(/\n+$/, '\n');
}

// 自动查找本机 mysql 容器（兼容 container 未配置的旧默认源）
async function findMysqlContainer() {
  const r1 = await run('docker', ['ps', '--format', '{{.Names}}', '--filter', 'name=mysql']);
  let names = (r1.stdout || '').split('\n').filter(Boolean);
  if (!names.length) {
    const r2 = await run('docker', ['ps', '--format', '{{.Names}}']);
    names = (r2.stdout || '').split('\n').filter((n) => /mysql|mariadb/i.test(n));
  }
  return names[0] || '';
}

function isPostgres(ds) {
  return ds.type === 'postgres' || ds.type === 'pg' || ds.type === 'postgresql';
}

// 根据数据源构造容器/命令行连接参数。
// - 配置 container 时，优先使用 docker exec（兼容数据库和配置台在同一 Compose 中的旧部署）；
// - 未配置 container 时，PostgreSQL 使用配置台镜像内的 psql 客户端；MySQL 由 query() 直接使用 mysql2 连接。
// 直接连接模式是内网/外部数据库的默认路径，不依赖数据库容器名称。
async function buildExecArgs(ds, sql, useDb = true) {
  let cont = ds.container;
  // 没有 host 时保留旧默认源的自动发现行为；只要填写了 host，就绝不猜测容器名。
  if (!cont && !String(ds.host || '').trim() && (isPostgres(ds) === false)) cont = await findMysqlContainer();
  if (isPostgres(ds)) {
    if (cont) {
      const args = ['exec'];
      if (ds.password) args.push('-e', 'PGPASSWORD=' + ds.password);
      args.push(cont, 'psql', '-h127.0.0.1', '-U', ds.user || 'postgres', '-t', '-A');
      if (useDb && ds.database) args.push('-d', ds.database);
      args.push('-c', sql);
      return args;
    }
    const args = ['psql', '--no-password', '-h', ds.host || '127.0.0.1', '-p', String(ds.port || '5432'), '-U', ds.user || 'postgres', '-t', '-A'];
    if (useDb && ds.database) args.push('-d', ds.database);
    args.push('-c', sql);
    return args;
  }
  // 默认 mysql / mariadb
  if (cont) {
    const args = ['exec', cont, 'mysql', '-h127.0.0.1', `-u${ds.user || 'root'}`, `-p${ds.password || ''}`,
      '--default-character-set=utf8mb4', '-N', '-B'];
    if (useDb && ds.database) args.push(ds.database);
    args.push('-e', sql);
    return args;
  }
  const args = ['mysql', '--no-defaults', '-h', ds.host || '127.0.0.1', '-P', String(ds.port || '3306'),
    `-u${ds.user || 'root'}`, `-p${ds.password || ''}`];
  args.push(ds.ssl ? '--ssl' : '--skip-ssl', '--default-character-set=utf8mb4', '-N', '-B');
  if (useDb && ds.database) args.push(ds.database);
  args.push('-e', sql);
  return args;
}

function formatCell(value) {
  if (value === null || value === undefined) return 'NULL';
  if (Buffer.isBuffer(value)) value = value.toString('utf8');
  return String(value).replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
}

async function queryExternalMysql(ds, sql, useDb = true) {
  const connection = await mysql.createConnection({
    host: ds.host || '127.0.0.1',
    port: Number(ds.port || 3306),
    user: ds.user || 'root',
    password: ds.password || '',
    database: useDb && ds.database ? ds.database : undefined,
    ssl: ds.ssl ? { rejectUnauthorized: false } : undefined,
    connectTimeout: 10000,
  });
  try {
    const [rows] = await connection.query(sql);
    if (!Array.isArray(rows)) return '';
    return rows
      .map((row) => Array.isArray(row) ? row : Object.values(row))
      .map((row) => row.map(formatCell).join('\t'))
      .join('\n');
  } finally {
    await connection.end();
  }
}

async function query(ds, sql, useDb = true) {
  const args = await buildExecArgs(ds, sql, useDb);
  const containerMode = args[0] === 'exec';
  if (!containerMode && !isPostgres(ds)) {
    return queryExternalMysql(ds, sql, useDb);
  }
  const command = containerMode ? 'docker' : args[0];
  const commandArgs = containerMode ? args : args.slice(1);
  const opts = {};
  if (!containerMode && isPostgres(ds) && ds.password) {
    opts.env = { ...process.env, PGPASSWORD: String(ds.password) };
  }
  const r = await run(command, commandArgs, opts);
  if (!r.ok) throw new Error(r.stderr || r.error || '数据库查询失败');
  return r.stdout;
}

// 列出数据源下的所有业务库
async function listDatabases(ds) {
  const out = await query(ds,
    ds.type === 'postgres' || ds.type === 'pg' || ds.type === 'postgresql'
      ? `SELECT datname FROM pg_database WHERE datistemplate = false AND datname NOT IN (${datasources.SYS_DBS.map((d) => `'${d}'`).join(',')}) ORDER BY datname`
      : `SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME NOT IN (${datasources.SYS_DBS.map((d) => `'${d}'`).join(',')}) ORDER BY SCHEMA_NAME`,
    false
  );
  return out.split('\n').filter(Boolean).map((name) => ({ name }));
}

// 列出表（支持跨库；dbs 为空则用数据源默认库）
async function listTables(ds, dbs = []) {
  const postgres = isPostgres(ds);
  const where = dbs && dbs.length
    ? `${postgres ? 'table_schema' : 'TABLE_SCHEMA'} IN (${dbs.map((d) => `'${String(d).replace(/'/g, "''")}'`).join(',')})`
    : `${postgres ? 'table_schema' : 'TABLE_SCHEMA'}='${String(ds.database || '').replace(/'/g, "''")}'`;
  const sql = postgres
    ? `SELECT table_schema, table_name, 0,
              COALESCE(obj_description((quote_ident(table_schema) || '.' || quote_ident(table_name))::regclass, 'pg_class'), '')
         FROM information_schema.tables
        WHERE table_type='BASE TABLE' AND ${where}
        ORDER BY table_name`
    : `SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_ROWS, TABLE_COMMENT
         FROM information_schema.TABLES
        WHERE ${where}
        ORDER BY TABLE_ROWS DESC`;
  const out = await query(
    ds,
    sql
  );
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [db, name, rows, comment] = line.split('\t');
      return { db, name, rows: rows || '0', comment: comment && comment !== 'NULL' ? comment : '', full: db + '.' + name };
    });
}

// 生成单个模型（支持跨库 + 多数据源）
async function generateModel(ds, db, table) {
  if (!/^[A-Za-z0-9_]+$/.test(db)) throw new Error('非法库名: ' + db);
  if (!/^[A-Za-z0-9_]+$/.test(table)) throw new Error('非法表名: ' + table);
  const out = await query(ds,
    `SELECT COLUMN_NAME, COLUMN_TYPE, COLUMN_KEY, COLUMN_COMMENT
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA='${db}' AND TABLE_NAME='${table}'
      ORDER BY ORDINAL_POSITION`);
  const lines = out.split('\n').filter(Boolean);
  if (!lines.length) throw new Error('表不存在或为空: ' + db + '.' + table);

  const columns = lines.map((line) => {
    const [name, type, key, comment] = line.split('\t');
    return {
      name,
      type,
      primaryKey: key === 'PRI',
      comment: comment && comment !== 'NULL' ? String(comment).trim() : '',
    };
  });

  let tableComment = '';
  try {
    const commentSql = isPostgres(ds)
      ? `SELECT COALESCE(obj_description(('${db}.${table}')::regclass, 'pg_class'), '')`
      : `SELECT TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA='${db}' AND TABLE_NAME='${table}'`;
    const tcOut = await query(ds, commentSql);
    const tc = tcOut.split('\n').filter(Boolean)[0];
    tableComment = tc && tc !== 'NULL' ? String(tc).trim() : '';
  } catch (_) {
    tableComment = '';
  }

  const scaffold = buildCubeScaffold({ ds, db, table, columns, tableComment });
  return scaffold;
}

module.exports = { listDatabases, listTables, generateModel, buildExecArgs, buildCubeScaffold };
