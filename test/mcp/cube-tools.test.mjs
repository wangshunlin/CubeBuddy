import assert from 'node:assert/strict';
import test from 'node:test';

import cubeTools from '../../server/lib/cube-tools.js';

const { normalizeLoadResponse } = cubeTools;

test('normalizeLoadResponse keeps the official Cube Core response shape', () => {
  const response = {
    queryType: 'regularQuery',
    results: [{ annotation: {}, data: [], lastRefreshTime: '2026-08-30T00:00:00.000Z' }],
  };
  assert.equal(normalizeLoadResponse(response), response);
});

test('normalizeLoadResponse wraps legacy flattened Cube responses', () => {
  const response = normalizeLoadResponse({
    queryType: 'regularQuery',
    annotation: {},
    data: [{ count: '3' }],
    lastRefreshTime: '2026-08-30T00:00:00.000Z',
  });

  assert.equal(response.queryType, 'regularQuery');
  assert.deepEqual(response.results, [{
    annotation: {},
    data: [{ count: '3' }],
    lastRefreshTime: '2026-08-30T00:00:00.000Z',
  }]);
});

test('normalizeLoadResponse rejects responses without results or legacy data', () => {
  assert.throws(() => normalizeLoadResponse({ queryType: 'regularQuery' }), /缺少 results/);
});
