import test from 'node:test';
import assert from 'node:assert/strict';
import { transitionAnalysisContext } from '../oracle/analysis-context.js';
import { resolveAnalyticalPlan } from '../oracle/analytical-plan.js';
import { assertEvidenceAgreement } from '../oracle/analysis-route-dispatcher.js';
import { acceptanceServer } from './helpers/oracle-acceptance.js';
import {
  multiPeriodFixture,
  multiPeriodPrompt
} from './helpers/multi-period-daily-fixture.js';
import { createEventSaleReportService } from '../oracle/event-sale-report.js';
import { createEventSaleProvider } from '../oracle/event-sale-provider.js';
const now = Date.parse('2026-11-05T12:00:00Z');
test('exact request owns independent period scope and day plan, clearing stale annual/product scope', () => {
  const stale = transitionAnalysisContext(
    null,
    'Compare Black Friday sales 2024 and 2025 online and in-store',
    { now }
  ).context;
  const c = transitionAnalysisContext(stale, multiPeriodPrompt, {
      now
    }).context,
    p = c.event_scope.periods;
  assert.equal(c.tool_route, 'compare_historical_events');
  assert.equal(c.grain, 'day');
  assert.equal(c.event_name, 'Requested sale periods');
  assert.deepEqual(c.dimensions, ['day', 'channel']);
  assert.equal(c.product_report, null);
  assert.equal(c.start_date, null);
  assert.equal(p.length, 3);
  assert.deepEqual(
    p.map((p) => p.channels),
    [['online'], ['online'], ['online', 'instore', 'unknown']]
  );
  assert.equal(p[0].start_at, '2024-11-08T08:00:00Z');
  assert.equal(p[0].end_exclusive, '2024-11-11T00:00:00Z');
  assert.equal(p[2].start_at, '2026-04-30T23:00:00Z');
  assert.equal(p[2].end_exclusive, '2026-05-04T23:00:00Z');
  assert.deepEqual(
    resolveAnalyticalPlan(c).event_selection.sale_scope,
    c.event_scope
  );
});
for (const durable of [false, true])
  test(
    'exact real ' +
      (durable ? 'durable' : 'interactive') +
      ' chat preserves sections, source predicates, daily rows, subtotals and recovery',
    async (t) => {
      const f = multiPeriodFixture(),
        h = await acceptanceServer(f, { durable, now });
      t.after(h.close);
      const r = await h.submit(multiPeriodPrompt, {
        fresh: true,
        id: 'daily-mixed-' + durable
      });
      assert.equal(r.evidence.sections.length, 5);
      assert.match(r.answer, /## May Bank Holiday 2026/);
      assert.doesNotMatch(r.answer, /## Black Friday 2026/);
      assert.match(r.answer, /2025-11-27 \| VIP/);
      assert.match(r.answer, /2025-11-28 \| Public/);
      assert.match(r.answer, /Daily \/ period reconciliation: matched/);
      assert.match(r.answer, /2024-11-08T08:00:00Z/);
      assert.match(r.answer, /2024-11-11T00:00:00Z/);
      assert.match(r.answer, /\| 2024-11-08 .*10.*-1.*9/);
      for (const s of r.evidence.sections) {
        assert.equal(s.reconciliation.status, 'matched');
        assert.equal(s.daily.evidence.grain, 'day');
        assert.ok(s.daily.evidence.rows.length);
        if (s.window.year !== 2026) assert.equal(s.window.channel, 'online');
      }
      for (const q of f.queries) {
        assert.doesNotMatch(
          q.query,
          /INSERT|UPDATE|DELETE|CREATE|MERGE|square_data/
        );
        if (q.params.start_at.startsWith('2024'))
          assert.doesNotMatch(q.query, /shopify_data/);
        else {
          assert.doesNotMatch(q.query, /metorik_/);
          assert.match(q.query, /matrixify_app_id/);
          assert.match(q.query, /=@sale_channel/);
        }
        if (q.query.includes("'refund' transaction_type"))
          assert.match(
            q.query,
            />= TIMESTAMP\(@start_at\).*< TIMESTAMP\(@end_exclusive\)/
          );
      }
      if (durable) {
        const count = f.queries.length;
        const recovered = await h.get('/jobs/' + r.job_id);
        assert.deepEqual(recovered.evidence, r.evidence);
        assert.equal(f.queries.length, count);
      }
    }
  );
for (const failure of ['failRefunds', 'failDaily', 'discrepancy'])
  test(
    failure +
      ' retains independent successes and unavailable/discrepant evidence',
    async () => {
      const f = multiPeriodFixture({ [failure]: true }),
        c = transitionAnalysisContext(null, multiPeriodPrompt, { now }).context;
      const r = await f.baseline(multiPeriodPrompt, { analysisContext: c });
      assertEvidenceAgreement(c, r.evidence);
      assert.equal(r.evidence.sections.length, 5);
      assert.ok(
        r.evidence.sections.find((s) => s.window.year === 2025).daily.evidence
          .rows.length
      );
      if (failure === 'failRefunds') {
        assert.match(r.answer, /Daily ww refunds unavailable/);
        assert.match(r.answer, /Unavailable/);
      }
      if (failure === 'failDaily')
        assert.match(r.answer, /Daily shopify sales unavailable/);
      if (failure === 'discrepancy')
        assert.match(r.answer, /reconciliation: discrepancy/);
    }
  );
test('scope validation rejects daily date/channel/source/grouping and reconciliation mutations', async () => {
  const f = multiPeriodFixture(),
    c = transitionAnalysisContext(null, multiPeriodPrompt, { now }).context,
    r = await f.baseline(multiPeriodPrompt, { analysisContext: c });
  for (const mutate of [
    (e) => (e.sections[0].daily.evidence.rows[0].date = '2024-11-11'),
    (e) => (e.sections[1].daily.evidence.rows[0].source = 'WooCommerce ww'),
    (e) => (e.sections[0].daily.evidence.grain = 'summary'),
    (e) => (e.sections[0].reconciliation.status = 'discrepancy'),
    (e) => (e.sections[0].daily.evidence.rows[0].channel = 'instore'),
    (e) =>
      (e.requested_scope.sale_scope.periods[0].end_exclusive =
        '2024-11-12T00:00:00Z')
  ]) {
    const e = structuredClone(r.evidence);
    mutate(e);
    assert.throws(
      () => assertEvidenceAgreement(c, e),
      (err) => err.code === 'EVIDENCE_SCOPE_MISMATCH'
    );
  }
});
test('failed totals retain daily evidence without allocating period totals', async () => {
  const c = transitionAnalysisContext(null, multiPeriodPrompt, { now }).context,
    f = multiPeriodFixture(),
    provider = createEventSaleProvider({
      bigquery: f.bigquery,
      project: 'fixture'
    });
  const svc = createEventSaleReportService({
    knowledgeService: { searchKnowledge: async () => ({ items: [] }) },
    provider: {
      totals: async () => {
        throw Error('period read failed');
      },
      daily: provider.daily
    }
  });
  const r = await svc(multiPeriodPrompt, { analysisContext: c });
  assertEvidenceAgreement(c, r.evidence);
  assert.ok(
    r.evidence.sections.every(
      (s) => s.daily.status === 'fulfilled' && s.totals.status === 'failed'
    )
  );
  assert.match(r.answer, /Daily \/ period reconciliation: unavailable/);
});

const { spawnSync } = await import('node:child_process');
const { timestampSalesSql } =
  await import('../oracle/event-timestamp-provider.js');
const { MATRIXIFY_APP_ID } = await import('../finance/canonical.js');
const python = process.env.ORACLE_SQL_PYTHON || 'python3';
const sqlAvailable =
  spawnSync(python, ['-c', 'import duckdb,sqlglot']).status === 0;
test(
  'executed daily SQL preserves Woo 08:00/exclusive bounds, Shopify source exclusions, BST and refund dates',
  { skip: !sqlAvailable },
  () => {
    const stamp = '2026-11-01T00:00:00Z';
    const run = (source, measure, params, data) => {
      const query = timestampSalesSql('fixture', source, measure, {
        shopifyChannel: source === 'shopify',
        grain: 'day'
      });
      const r = spawnSync(
        python,
        [new URL('./event-daily-sales-sql.py', import.meta.url).pathname],
        { input: JSON.stringify({ query, params, ...data }), encoding: 'utf8' }
      );
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout);
    };
    const woo = {
      metorik_uk_orders: [
        ['before', '2024-11-08T07:59:59Z', stamp, 'completed', 999, 'GBP'],
        ['start', '2024-11-08T08:00:00Z', stamp, 'completed', 10, 'GBP'],
        ['day2', '2024-11-09T00:00:00Z', stamp, 'processing', 20, 'GBP'],
        ['end', '2024-11-11T00:00:00Z', stamp, 'completed', 999, 'GBP']
      ],
      metorik_uk_refunds_api: [
        ['refund', 'before', stamp, 2, '2024-11-10T23:59:59Z'],
        ['end-refund', 'start', stamp, 999, '2024-11-11T00:00:00Z']
      ]
    };
    const wp = {
      start_at: '2024-11-08T08:00:00Z',
      end_exclusive: '2024-11-11T00:00:00Z'
    };
    assert.deepEqual(
      run('ww', 'sales', wp, woo)
        .map((r) => [r.date, r.amount])
        .sort(),
      [
        ['2024-11-08', 10],
        ['2024-11-09', 20]
      ]
    );
    assert.deepEqual(
      run('ww', 'refunds', wp, woo).map((r) => [r.date, r.amount]),
      [['2024-11-10', -2]]
    );
    const orders = [
      ['before', '2026-04-30T22:59:59Z', null, 'Online Store', null, 999],
      ['start', '2026-04-30T23:00:00Z', null, 'Online Store', null, 10],
      ['day2', '2026-05-01T23:00:00Z', null, 'Online Store', null, 20],
      ['end', '2026-05-04T23:00:00Z', null, 'Online Store', null, 999],
      [
        'import',
        '2026-05-01T12:00:00Z',
        null,
        'Online Store',
        MATRIXIFY_APP_ID,
        999
      ],
      ['pos', '2026-05-02T12:00:00Z', 'A', 'pos', null, 30],
      ['unknown', '2026-05-02T12:00:00Z', null, 'api', null, 40]
    ];
    const data = {
      ...woo,
      order_financials: orders.map((o) => [
        o[0],
        o[1],
        stamp,
        null,
        'GBP',
        o[5],
        JSON.stringify([{ status: 'SUCCESS', kind: 'SALE' }])
      ]),
      order_locations: orders.map((o) => [o[0], stamp, o[2], o[3], o[4]]),
      order_refunds: [
        ['r', 'before', stamp, 'GBP', 2, true, '2026-05-03T23:00:00Z'],
        ['ri', 'import', stamp, 'GBP', 999, true, '2026-05-02T12:00:00Z']
      ]
    };
    const sp = {
      start_at: '2026-04-30T23:00:00Z',
      end_exclusive: '2026-05-04T23:00:00Z',
      matrixify_app_id: MATRIXIFY_APP_ID,
      sale_channel: 'online',
      sale_sessions_json: '[]'
    };
    assert.deepEqual(
      run('shopify', 'sales', sp, data)
        .map((r) => [r.date, r.amount])
        .sort(),
      [
        ['2026-05-01', 10],
        ['2026-05-02', 20]
      ]
    );
    assert.deepEqual(
      run('shopify', 'refunds', sp, data).map((r) => [r.date, r.amount]),
      [['2026-05-04', -2]]
    );
    assert.equal(
      run('shopify', 'sales', { ...sp, sale_channel: 'instore' }, data)[0]
        .amount,
      30
    );
    assert.equal(
      run('shopify', 'sales', { ...sp, sale_channel: 'unknown' }, data)[0]
        .amount,
      40
    );
  }
);

const { liveMultiPeriodPrompt } =
  await import('./helpers/multi-period-daily-fixture.js');
const { eventSaleFixture } = await import('./helpers/event-sale-fixture.js');
const { readFileSync } = await import('node:fs');
test('retained live job proves fresh 9065a91 parser fallback, not an inferred stale result', () => {
  const before = JSON.parse(
    readFileSync(
      new URL(
        './fixtures/multi-period-daily-sales/live-before-scope.json',
        import.meta.url
      )
    )
  );
  assert.equal(
    before.submitted_revision,
    '9065a91bba6ca53aba680e49a559919b5a29c273'
  );
  assert.equal(before.execution_revision, before.submitted_revision);
  assert.equal(before.previous_scope.event_scope, null);
  assert.equal(before.effective_message_differs, false);
  assert.equal(before.submitted_scope.grain, null);
  assert.equal(before.returned_scope.event_name, 'Black Friday');
  assert.equal(before.answer_heading, '# Black Friday sale periods');
  const c = transitionAnalysisContext(null, liveMultiPeriodPrompt, {
    now
  }).context;
  assert.equal(c.event_scope.source_policy, 'explicit-sale-periods-v1');
  assert.equal(c.grain, 'day');
  assert.deepEqual(
    c.event_scope.periods.map((p) => [p.source, p.channels]),
    [
      ['woo', ['online']],
      ['shopify', ['online']],
      ['shopify', ['online', 'instore', 'unknown']]
    ]
  );
  assert.equal(c.event_scope.periods[0].start_at, '2024-11-08T08:00:00Z');
  assert.equal(c.event_scope.periods[0].end_exclusive, '2024-11-11T00:00:00Z');
  assert.equal(c.event_scope.periods[1].vip_date, '2025-11-27');
});
for (const durable of [false, true])
  test(
    'verbatim retained live prompt after old report and recovery, HTTP ' +
      (durable ? 'jobs' : 'chat'),
    async (t) => {
      const f = multiPeriodFixture(),
        old = eventSaleFixture(),
        selected = [],
        stages = [],
        daily = f.baseline;
      f.baseline = (message, options) => {
        const path = options.analysisContext?.event_scope?.periods
          ? 'daily'
          : 'legacy';
        selected.push(path);
        return (path === 'daily' ? daily : old.baseline)(message, {
          ...options,
          onProviderStage: (event) => {
            stages.push(event);
            options.onProviderStage?.(event);
          }
        });
      };
      const h = await acceptanceServer(f, {
        durable,
        now,
        revision: '9065a91bba6ca53aba680e49a559919b5a29c273'
      });
      t.after(h.close);
      const prior = await h.submit(
        'Compare Black Friday sales 2024 and 2025 online and in-store',
        { fresh: true, id: 'legacy-before-live' }
      );
      if (durable) await h.get('/jobs/' + prior.job_id);
      const before = f.queries.length;
      const route = await fetch(h.base + '/analysis/route', {
        method: 'POST',
        headers: h.headers,
        body: JSON.stringify({ message: liveMultiPeriodPrompt })
      }).then((r) => r.json());
      assert.equal(route.providers_attempted, 0);
      assert.equal(route.event_scope.source_policy, 'explicit-sale-periods-v1');
      assert.equal(f.queries.length, before);
      const result = await h.submit(liveMultiPeriodPrompt, {
        id: 'verbatim-live-after-419'
      });
      assert.deepEqual(selected, ['legacy', 'daily']);
      assert.equal(f.queries.length - before, 24);
      assert.equal(result.analysis_context.grain, 'day');
      assert.equal(result.evidence.sections.length, 5);
      assert.ok(
        result.evidence.sections.every((s) => s.daily.status === 'fulfilled')
      );
      assert.deepEqual(
        durable
          ? h.jobs.jobs.get(result.job_id).result_json.tools
          : result.tools,
        ['search_knowledge', 'event_timestamp_sales', 'event_daily_sales']
      );
      assert.ok(
        stages.some((s) => s.stage === 'event_daily' && s.status === 'success')
      );
      assert.match(result.answer, /## May Bank Holiday 2026/);
      assert.match(result.answer, /2025-11-27 \| VIP/);
      const shopifyQueries = f.queries.filter(
        (q) => !q.params.start_at.startsWith('2024')
      );
      assert.ok(shopifyQueries.length);
      assert.ok(shopifyQueries.every((q) => !q.query.includes('metorik_')));
      if (durable) {
        const saved = h.jobs.jobs.get(result.job_id);
        assert.equal(
          saved.payload_json.original_message,
          liveMultiPeriodPrompt
        );
        assert.equal(
          saved.payload_json.execution_revision,
          '9065a91bba6ca53aba680e49a559919b5a29c273'
        );
        assert.equal(
          saved.payload_json.analysis_context.event_scope.source_policy,
          'explicit-sale-periods-v1'
        );
        const n = f.queries.length;
        const retry = await h.submit(liveMultiPeriodPrompt, {
          id: 'verbatim-live-after-419'
        });
        assert.equal(retry.job_id, result.job_id);
        assert.equal(f.queries.length, n);
        const recovered = await h.get('/jobs/' + result.job_id);
        assert.deepEqual(recovered.evidence, result.evidence);
        assert.equal(f.queries.length, n);
      }
    }
  );
test('ordinary at/until and source exclusion wording preserve equivalent independent scope', () => {
  const scope = transitionAnalysisContext(null, liveMultiPeriodPrompt, { now })
    .context.event_scope;
  for (const wording of [
    liveMultiPeriodPrompt.replace('until 11 November', 'to 11 November'),
    liveMultiPeriodPrompt.replace('at 08:00', 'at 8:00'),
    liveMultiPeriodPrompt.replace(
      'Split Online Store and POS',
      'Split Online Store/POS'
    ),
    liveMultiPeriodPrompt.replace(
      'Exclude POS and migrated WooCommerce orders.',
      'Excluding imported WooCommerce orders and POS.'
    )
  ])
    assert.deepEqual(
      transitionAnalysisContext(null, wording, { now }).context.event_scope,
      scope
    );
});
