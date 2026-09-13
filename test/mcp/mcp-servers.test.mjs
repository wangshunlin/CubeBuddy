import assert from 'node:assert/strict';
import test from 'node:test';

import mcpServers from '../../server/lib/mcp-servers.js';

function serviceFixture() {
  const calls = [];
  return {
    calls,
    async meta({ name }) {
      const cubes = [{ name: 'orders' }, { name: 'finance' }];
      return { cubes: name ? cubes.filter((cube) => cube.name === name) : cubes, summary: !name, generatedAt: 1 };
    },
    async load(input) { calls.push(['load', input]); return { results: [] }; },
    async dryRun(input) { calls.push(['dryRun', input]); return {}; },
    async search(input) { calls.push(['search', input]); return { results: [] }; },
    glossaryResolve() { return { ok: true, hits: [] }; },
  };
}

test('scoped MCP service filters metadata and blocks unbound semantic models', async () => {
  const source = serviceFixture();
  const scoped = mcpServers.createScopedCubeToolService(source, {
    id: 'sales-agent', modelIds: ['orders'], enabled: true,
  });

  assert.deepEqual((await scoped.meta({})).cubes, [{ name: 'orders' }]);
  await assert.rejects(scoped.meta({ name: 'finance' }), /无权访问语义模型 finance/);

  await scoped.load({ query: { measures: ['orders.count'], filters: [{ member: 'orders.status', operator: 'equals', values: ['paid'] }] } });
  assert.equal(source.calls.length, 1);

  await assert.rejects(
    scoped.dryRun({ query: { measures: ['orders.count'], filters: [{ or: [{ member: 'finance.profit', operator: 'gt', values: ['0'] }] }] } }),
    /无权访问语义模型 finance/,
  );
  await assert.rejects(scoped.search({ dimension: 'finance.department', query: '预算' }), /无权访问语义模型 finance/);
  assert.equal(source.calls.length, 1);
});

test('queryMembers includes all supported semantic member locations', () => {
  const members = mcpServers.queryMembers({
    measures: ['orders.amount'], dimensions: ['orders.status'], segments: ['orders.completed'],
    timeDimensions: [{ dimension: 'orders.created_at' }],
    filters: [{ and: [{ member: 'orders.region' }, { or: [{ dimension: 'orders.channel' }] }] }],
    order: { 'orders.amount': 'desc' },
  });
  assert.deepEqual(members.sort(), ['orders.amount', 'orders.channel', 'orders.completed', 'orders.created_at', 'orders.region', 'orders.status']);
});
