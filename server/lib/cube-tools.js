'use strict';

class CubeToolError extends Error {
  constructor(message, { status = 500, data, code = 'cube_tool_error' } = {}) {
    super(message);
    this.name = 'CubeToolError';
    this.status = status;
    this.data = data;
    this.code = code;
  }
}

function errorMessage(data, fallback) {
  if (typeof data === 'string' && data.trim()) return data.trim();
  if (data && typeof data === 'object') {
    for (const key of ['error', 'message', 'detail']) {
      if (typeof data[key] === 'string' && data[key].trim()) return data[key].trim();
    }
  }
  return fallback;
}

function normalizeLoadResponse(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new CubeToolError('Cube 返回了无效的查询响应', { status: 502, data, code: 'invalid_cube_response' });
  }
  if (Array.isArray(data.results)) return data;

  // 兼容旧版 Cube 的扁平 load 响应；原生 MCP 始终对外返回官方 results 包装。
  if (Array.isArray(data.data) || (data.annotation && typeof data.annotation === 'object')) {
    const result = {};
    for (const key of [
      'query', 'dataSource', 'dbType', 'extDbType', 'external', 'slowQuery',
      'annotation', 'data', 'usedPreAggregations', 'refreshKeyValues', 'lastRefreshTime',
    ]) {
      if (data[key] !== undefined) result[key] = data[key];
    }
    return {
      ...(data.queryType !== undefined ? { queryType: data.queryType } : {}),
      ...(data.slowQuery !== undefined ? { slowQuery: data.slowQuery } : {}),
      ...(data.pivotQuery !== undefined ? { pivotQuery: data.pivotQuery } : {}),
      results: [result],
    };
  }

  throw new CubeToolError('Cube 查询响应缺少 results', { status: 502, data, code: 'missing_results' });
}

function createCubeTools({ apiBase, resolveGlossary, timeoutMs = 60000 } = {}) {
  const base = String(apiBase || '').replace(/\/$/, '');
  if (!base) throw new Error('createCubeTools 缺少 apiBase');

  async function request(pathname, { method = 'GET', token, body } = {}) {
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let response;
    try {
      response = await fetch(base + pathname, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new CubeToolError(`Cube API 不可用：${error.message || error}`, {
        status: 502,
        code: 'cube_unavailable',
      });
    }

    const text = await response.text();
    let data;
    try { data = JSON.parse(text); }
    catch (_) { data = text; }

    if (!response.ok) {
      throw new CubeToolError(errorMessage(data, `Cube API 返回 HTTP ${response.status}`), {
        status: response.status,
        data,
        code: 'cube_http_error',
      });
    }
    return data;
  }

  async function meta({ token, name = '' } = {}) {
    const data = await request('/cubejs-api/v1/meta', { token });
    const all = Array.isArray(data?.cubes) ? data.cubes : [];
    if (name) {
      const hit = all.find((cube) => cube?.name === name);
      if (!hit) {
        throw new CubeToolError(`cube 不存在: ${name}`, {
          status: 404,
          data: { available: all.map((cube) => cube?.name).filter(Boolean) },
          code: 'cube_not_found',
        });
      }
      return { cubes: [hit], summary: false, generatedAt: Date.now() };
    }
    return {
      cubes: all.map((cube) => ({
        name: cube.name,
        title: cube.title,
        description: cube.description,
        measureCount: Array.isArray(cube.measures) ? cube.measures.length : 0,
        dimensionCount: Array.isArray(cube.dimensions) ? cube.dimensions.length : 0,
        segmentCount: Array.isArray(cube.segments) ? cube.segments.length : 0,
      })),
      summary: true,
      generatedAt: Date.now(),
    };
  }

  async function load({ token, query, cache } = {}) {
    const body = { query };
    if (cache !== undefined) body.cache = cache;
    return normalizeLoadResponse(await request('/cubejs-api/v1/load', { method: 'POST', token, body }));
  }

  async function dryRun({ token, query } = {}) {
    return request('/cubejs-api/v1/dry-run', { method: 'POST', token, body: { query } });
  }

  async function search({ token, dimension, query, limit = 100 } = {}) {
    return load({
      token,
      query: {
        dimensions: [dimension],
        filters: [{ member: dimension, operator: 'contains', values: [query] }],
        limit,
      },
    });
  }

  function glossaryResolve({ text } = {}) {
    const hits = typeof resolveGlossary === 'function' ? resolveGlossary(text) : [];
    return { ok: true, hits: Array.isArray(hits) ? hits : [] };
  }

  return { request, meta, load, dryRun, search, glossaryResolve };
}

module.exports = { CubeToolError, createCubeTools, normalizeLoadResponse };
