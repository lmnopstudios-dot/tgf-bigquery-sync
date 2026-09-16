import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AcquisitionValidationError,
  extractAcquisition,
  parseDateRange,
  promoteAcquisitionWindow,
  validateRows
} from '../shopify/acquisition.js';

const visit = (id, overrides = {}) => ({
  __typename: 'CustomerVisit', id, occurredAt: '2026-09-15T10:00:00Z',
  landingPage: 'https://thegreatfroglondon.com/rings?utm_source=ignored&checkout=secret#fragment',
  referrerUrl: 'https://www.google.com/search?q=private', referralCode: null,
  source: 'Google', sourceDescription: 'Search', sourceType: 'SEARCH',
  utmParameters: { source: null, medium: null, campaign: null, content: null, term: null },
  ...overrides
});

const order = (overrides = {}) => ({
  id: 'gid://shopify/Order/1', createdAt: '2026-09-15T09:00:00Z',
  updatedAt: '2026-09-15T11:00:00Z', sourceName: 'web',
  attribution: { handle: 'web', displayName: 'Online Store' },
  app: { id: 'gid://shopify/App/580111', name: 'Online Store' },
  customerJourneySummary: {
    ready: true, customerOrderIndex: 1, daysToConversion: 2,
    firstVisit: visit('v1'), lastVisit: visit('v3'),
    moments: { nodes: [visit('v1'), visit('v2')], pageInfo: { hasNextPage: true, endCursor: 'p1' } }
  }, ...overrides
});

function graphqlFixture(orders, continuation) {
  return async (query, variables) => query.includes('AcquisitionOrders')
    ? { orders: { nodes: orders, pageInfo: { hasNextPage: false, endCursor: null } } }
    : continuation(query, variables);
}

test('normalizes web, guest, first/last, UTM and multiple moment pages without raw URLs', async () => {
  const third = visit('v3', { utmParameters: {
    source: 'newsletter', medium: 'email', campaign: 'launch', content: 'hero', term: 'silver'
  } });
  const rows = await extractAcquisition({
    graphql: graphqlFixture([order()], async () => ({ order: { customerJourneySummary: {
      moments: { nodes: [third], pageInfo: { hasNextPage: false, endCursor: null } }
    } } })),
    startDate: '2026-09-15', endExclusive: '2026-09-16T00:00:00.000Z',
    now: () => new Date('2026-09-16T12:00:00Z'), sleep: async () => {}
  });
  assert.equal(rows.acquisition[0].attribution_handle, 'web');
  assert.equal(rows.acquisition[0].journey_moment_count, 3);
  assert.equal(rows.acquisition[0].journey_pagination_complete, true);
  assert.equal(rows.acquisition[0].first_visit_landing_host, 'thegreatfroglondon.com');
  assert.equal(rows.acquisition[0].first_visit_landing_path, '/rings');
  assert.equal(rows.acquisition[0].first_visit_referrer_host, 'www.google.com');
  assert.equal(rows.acquisition[0].first_visit_utm_source, null);
  assert.equal(rows.moments[2].utm_campaign, 'launch');
  assert.equal(rows.moments[0].is_first_visit, true);
  assert.equal(rows.moments[2].is_last_visit, true);
  assert.deepEqual(rows.moments.map(row => row.moment_sequence), [1, 2, 3]);
  assert.equal(JSON.stringify(rows).includes('?'), false);
  assert.equal(JSON.stringify(rows).includes('checkout=secret'), false);
  // No customer identity is queried or required: this fixture represents a guest order.
  assert.equal('customer_id' in rows.acquisition[0], false);
});

test('uses explicit UTC Shopify bounds and rejects results outside that window', async () => {
  let search;
  await assert.rejects(extractAcquisition({
    graphql: async (_query, variables) => {
      search = variables.query;
      return { orders: { nodes: [order({
        id: 'outside', createdAt: '2026-09-16T00:00:00.000Z', customerJourneySummary: null
      })], pageInfo: { hasNextPage: false, endCursor: null } } };
    },
    startDate: '2026-09-15', endExclusive: '2026-09-16T00:00:00.000Z'
  }), /outside the requested UTC window: outside/);
  assert.equal(search,
    "created_at:>='2026-09-15T00:00:00.000Z' created_at:<'2026-09-16T00:00:00.000Z'");
});

test('accepts a POS ready journey with zero moments', async () => {
  const pos = order({
    attribution: { handle: 'pos', displayName: 'Point of Sale' }, sourceName: 'pos',
    customerJourneySummary: { ready: true, customerOrderIndex: 2, daysToConversion: 0,
      firstVisit: null, lastVisit: null,
      moments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } }
  });
  const rows = await extractAcquisition({
    graphql: graphqlFixture([pos], () => assert.fail('no continuation expected')),
    startDate: '2026-09-15', endExclusive: '2026-09-16T00:00:00.000Z'
  });
  assert.equal(rows.acquisition[0].journey_available, true);
  assert.equal(rows.acquisition[0].journey_ready, true);
  assert.equal(rows.acquisition[0].journey_moment_count, 0);
  assert.deepEqual(rows.moments, []);
});

test('missing journey differs from a zero-moment journey', async () => {
  const rows = await extractAcquisition({
    graphql: graphqlFixture([order({ customerJourneySummary: null })], () => {}),
    startDate: '2026-09-15', endExclusive: '2026-09-16T00:00:00.000Z'
  });
  assert.equal(rows.acquisition[0].journey_available, false);
  assert.equal(rows.acquisition[0].journey_ready, null);
});

test('Matrixify classification uses only the established app ID', async () => {
  const rows = await extractAcquisition({
    graphql: graphqlFixture([
      order({ id: 'matrix', app: { id: 'gid://shopify/App/1758145', name: 'anything' }, customerJourneySummary: null }),
      order({ id: 'name-only', app: { id: 'other', name: 'Matrixify' }, customerJourneySummary: null })
    ], () => {}), startDate: '2026-09-15', endExclusive: '2026-09-16T00:00:00.000Z'
  });
  assert.deepEqual(rows.acquisition.map(row => row.is_matrixify_import), [true, false]);
});

test('pagination failure retains observed moments and marks the order incomplete', async () => {
  const rows = await extractAcquisition({
    graphql: graphqlFixture([order()], async () => { throw new Error('network'); }),
    startDate: '2026-09-15', endExclusive: '2026-09-16T00:00:00.000Z'
  });
  assert.equal(rows.moments.length, 2);
  assert.equal(rows.acquisition[0].journey_pagination_complete, false);
});

test('validation rejects duplicate orders and duplicate moment identities', () => {
  const base = { order_id: '1', app_id: null, is_matrixify_import: false };
  assert.throws(() => validateRows([base, base], []), AcquisitionValidationError);
  assert.throws(() => validateRows([base], [
    { order_id: '1', moment_id: 'm', moment_sequence: 1 },
    { order_id: '1', moment_id: 'm', moment_sequence: 2 }
  ]), AcquisitionValidationError);
});

test('strict date validation rejects malformed, impossible and reversed ranges', () => {
  assert.throws(() => parseDateRange({ start_date: '09/15/2026', end_date: '2026-09-16' }));
  assert.throws(() => parseDateRange({ start_date: '2026-02-30', end_date: '2026-03-01' }));
  assert.throws(() => parseDateRange({ start_date: '2026-09-16', end_date: '2026-09-15' }));
  assert.equal(parseDateRange({ start_date: '2026-09-15', end_date: '2026-09-15' }).endExclusive,
    '2026-09-16T00:00:00.000Z');
});

function fakeBigQuery({ failPromotion = false } = {}) {
  const queries = [];
  const tables = new Map();
  const dataset = {
    exists: async () => [true],
    table(name) {
      if (!tables.has(name)) tables.set(name, { exists: async () => [true], insert: async () => {}, delete: async () => {} });
      return tables.get(name);
    },
    async createTable(name) {
      const table = { exists: async () => [true], insert: async rows => { table.rows = rows; }, delete: async () => {} };
      tables.set(name, table); return [table];
    }
  };
  return {
    queries,
    dataset: () => dataset, createDataset: async () => {},
    query: async options => {
      queries.push(options);
      if (options.query.includes('SELECT\n')) {
        const stages = [...tables.entries()].filter(([name]) => name.startsWith('_staging'));
        return [[{ acquisition_count: stages[0][1].rows?.length ?? 0, moment_count: stages[1][1].rows?.length ?? 0 }]];
      }
      if (failPromotion) throw new Error('transaction failed');
      return [[]];
    }
  };
}

test('promotion uses one coordinated transaction and preserves rows outside the affected window', async () => {
  const bigquery = fakeBigQuery();
  await promoteAcquisitionWindow({ bigquery, projectId: 'project', startDate: '2026-09-15',
    endExclusive: '2026-09-16T00:00:00.000Z', acquisition: [], moments: [] });
  const promotion = bigquery.queries.at(-1);
  assert.match(promotion.query, /BEGIN TRANSACTION/);
  assert.match(promotion.query, /order_journey_moments/);
  assert.match(promotion.query, /order_acquisition/);
  assert.match(promotion.query, /order_created_at >= TIMESTAMP\(@startDate\)/);
  assert.doesNotMatch(promotion.query, /WHERE TRUE/);
  assert.deepEqual(promotion.params, { startDate: '2026-09-15T00:00:00.000Z', endExclusive: '2026-09-16T00:00:00.000Z' });
});

test('promotion refuses to insert rows outside the window it replaces', async () => {
  await assert.rejects(promoteAcquisitionWindow({
    bigquery: fakeBigQuery(), projectId: 'project', startDate: '2026-09-15',
    endExclusive: '2026-09-16T00:00:00.000Z',
    acquisition: [{ order_id: 'outside', order_created_at: '2026-09-16T00:00:00.000Z',
      app_id: null, is_matrixify_import: false }], moments: []
  }), /Promotion rows fall outside/);
});

test('a failed coordinated transaction is surfaced and cannot partially promote', async () => {
  const bigquery = fakeBigQuery({ failPromotion: true });
  await assert.rejects(promoteAcquisitionWindow({ bigquery, projectId: 'project', startDate: '2026-09-15',
    endExclusive: '2026-09-16T00:00:00.000Z', acquisition: [], moments: [] }), /transaction failed/);
  assert.equal(bigquery.queries.filter(item => item.query.includes('BEGIN TRANSACTION')).length, 1);
});
