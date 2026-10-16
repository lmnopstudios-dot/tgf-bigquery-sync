import { main as campaignDiagnostic } from '../diagnostics/oracle-campaign-selection.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {
  transitionAnalysisContext,
  validateAnalysisContext,
} from '../oracle/analysis-context.js';
import {
  dispatchAnalysisRequest,
  executeGovernedAgentAnalysis,
  assertEvidenceAgreement,
  assertResolvedAnalysisContext,
} from '../oracle/analysis-route-dispatcher.js';
import { createBaselineOverviewService } from '../oracle/baseline-overview.js';
import { createOracleProviderDependencies } from '../oracle/provider-dependencies.js';
import { createOracleUiRouter } from '../oracle/ui-router.js';
import { createMemoryAnalysisJobStore } from '../oracle/analysis-jobs.js';
import {
  createMemoryExportStore,
  sendPriorityDownload,
} from '../oracle/product-priority-storage.js';
import { assertProductArtifact } from '../oracle/product-artifact-validation.js';
import { presentAnalyticalAnswer } from '../oracle/answer-presentation.js';
import { deliverOracleResult } from '../oracle/result-delivery.js';
import { resolveAnalyticalPlan } from '../oracle/analytical-plan.js';
const NOW = Date.parse('2026-10-09T12:00:00Z');
const QUESTION = 'How did the last 3 Klaviyo campaigns go?';
const apply = (prior, text) =>
  transitionAnalysisContext(prior, text, { now: NOW }).context;
const campaign = (id, index = Number(id)) => ({
  entity_id: `c${id}`,
  entity_name: `Campaign ${id}`,
  entity_kind: 'campaign',
  status: 'sent',
  is_sent: true,
  account: 'production',
  channel: 'email',
  send_time: `2026-09-${String(29 - index).padStart(2, '0')}T23:30:00Z`,
  send_time_semantics: 'actual campaign send timestamp',
  reporting_timezone: 'Europe/London',
  reporting_cutoff: '2026-09-30',
  retrieved_at: '2026-10-01T12:00:00Z',
});
function fixture({
  candidates = [6, 3, 1, 4, 2, 5].map((x) => campaign(x)),
  failId = null,
  production = false,
  live = false,
} = {}) {
  const calls = [],
    resolverCalls = [],
    queryCalls = [],
    discoveryCalls = [],
    exports = createMemoryExportStore();
  const row = (id) => ({
    entity_id: id,
    entity_name: `Campaign ${id.slice(1)}`,
    report_kind: 'campaign',
    conversion_metric_id: 'placed',
    metric_provenance: 'shopify:Placed Order',
    currency: 'GBP',
    delivered: 100,
    unique_clicks: 12,
    unique_click_rate: 0.12,
    attributed_conversion_events: 3,
    attributed_conversion_value: 30,
    actual_start_date: '2026-09-01',
    actual_end_date: '2026-09-30',
    attribution_settings: '5 day click/open',
    reporting_timezone: 'Europe/London',
  });
  const provider = async (name, args) => {
    calls.push({ name, args });
    if (args.campaign_id === failId)
      throw Error('raw customer provider failure must not be logged');
    return {
      success: true,
      reporting_granularity: 'calendar_month',
      rows: [row(args.campaign_id)],
      coverage: { complete: true, latest_retrieved_at: '2026-10-01T12:00:00Z' },
    };
  };
  provider.resolveCampaigns = async (args) => {
    resolverCalls.push(args);
    return { complete: true, candidates };
  };
  const bq = {
    dataset: () => ({ getMetadata: async () => [{ location: 'US' }] }),
    query: async (a) => {
      queryCalls.push(a);
      if (a.query.includes('SELECT CAST(MAX')) return [[{reporting_cutoff:'2026-09-30'}]];
      if (a.query.includes('entity_metadata')) return [[...candidates]];
      if (a.query.includes('message_performance')) {
        if(a.params.campaign_id===failId) throw Error('private provider fixture failure');
        calls.push({
          name: 'get_klaviyo_email_performance',
          args: {
            campaign_id: a.params.campaign_id,
            start_date: a.params.start_date.value,
            end_date: a.params.end_date.value,
          },
        });
        return [[row(a.params.campaign_id)]];
      }
      if (a.query.includes('window_coverage'))
        return [
          [
            {
              month_start: '2026-09-01',
              month_end: '2026-09-30',
              status: 'collected',
              retrieved_at: '2026-10-01T12:00:00Z',
            },
          ],
        ];
      throw Error('Unexpected query');
    },
  };
  const actual = production
    ? createOracleProviderDependencies({
        bigquery: bq,
        project: 'fixture',
        env: live ? {KLAVIYO_PRIVATE_API_KEY:'fixture-private',KLAVIYO_API_REVISION:'2026-07-15'} : {},
        klaviyoFetch: async (url, options) => {
          discoveryCalls.push({url,method:options.method});
          assert.equal(options.method,'GET');
          const page=new URL(url).searchParams.has('page[cursor]')?1:0;
          const groups=[candidates.slice(0,2),candidates.slice(2)];
          return {ok:true,status:200,json:async()=>({data:groups[page].map(c=>({type:'campaign',id:c.entity_id,attributes:{name:c.entity_name,status:c.status,send_time:c.send_time,send_strategy:{method:'static'}},relationships:{'campaign-messages':{data:[{id:c.entity_id+'-a'},{id:c.entity_id+'-b'}]}}})),included:[],links:{next:page?null:'https://a.klaviyo.com/api/campaigns?page[cursor]=next'}})};
        },
      }).klaviyo
    : provider;
  return {
    calls,
    resolverCalls,
    discoveryCalls,
    queryCalls,
    bq,
    exports,
    provider,
    baseline: createBaselineOverviewService({
      klaviyo: actual,
      socialExportStore: exports,
      now: () => new Date(NOW),
    }),
  };
}
async function send(
  f,
  prior,
  message = QUESTION,
  { direct = false, recent = null, id = 'r1' } = {},
) {
  const context = apply(prior, message),
    options = { recentEvidence: recent, exportOwner: 'owner', requestId: id };
  const r = direct
    ? await executeGovernedAgentAnalysis({
        message,
        analysisContext: context,
        scopeResolved: true,
        baselineOverview: f.baseline,
        baselineOptions: options,
        now: NOW,
      })
    : await dispatchAnalysisRequest({
        message,
        analysisContext: context,
        baselineOverview: f.baseline,
        baselineOptions: options,
      });
  return { ...r, context: r.analysis_context || context };
}
function verify(r, f) {
  assert.doesNotMatch(r.answer, /What date range/);
  assert.equal(r.evidence.kind, 'governed_klaviyo_campaign_set');
  assert.deepEqual(
    r.evidence.campaigns.map((c) => c.entity_id),
    ['c1', 'c2', 'c3'],
  );
  assert.deepEqual(
    f.calls.slice(-3).map((c) => c.args.campaign_id),
    ['c1', 'c2', 'c3'],
  );
  assert.deepEqual(
    f.calls.slice(-3).map((c) => c.args.start_date),
    ['2026-09-29', '2026-09-28', '2026-09-27'],
  );
  assert.ok(f.calls.slice(-3).every((c) => c.args.end_date === '2026-09-30'));
  assert.equal(r.evidence.sections.length, 3);
  assert.match(
    r.answer,
    /Campaign \| Sent \| Delivered \| Click rate \| Attributed purchases\/conversions \| Attributed revenue/,
  );
  assert.match(r.answer, /actual send timestamp/);
  assert.match(r.answer, /newest can be provisional/);
  assert.match(r.answer, /common elapsed-window comparisons are unavailable/);
  assert.match(r.answer, /GBP/);
  assert.match(r.answer, /exact post-send slicing/);
  assert.match(
    r.presentation.summary_markdown,
    /\| Campaign \|[^\n]*\n\|---\|[^\n]*\n\| Campaign 1/,
  );
  assert.doesNotThrow(() =>
    assertEvidenceAgreement(
      JSON.parse(JSON.stringify(r.context)),
      JSON.parse(JSON.stringify(r.evidence)),
    ),
  );
}
for (const prior of [
  null,
  'Show mobile and desktop conversion rates this year.',
  'Export pendants by units sold.',
  'Show shipping countries in September 2026.',
  'Show Black Friday sales.',
])
  for (const direct of [false, true])
    for (const phrase of [
      QUESTION,
      'How did the most recent three Klaviyo campaigns perform?',
      'Show results for the last three email campaigns.',
    ])
      test(`entity selection ${direct ? 'agent' : 'shared'} ${phrase} after ${prior || 'fresh'}`, async () => {
        const f = fixture();
        verify(
          await send(f, prior ? apply(null, prior) : null, phrase, { direct }),
          f,
        );
      });
test('production factories receive actual ordered IDs, account/channel and resolved windows', async () => {
  const f = fixture({ production: true, live: true }),
    r = await send(f, null);
  verify(r, f);
  const queries = f.queryCalls.filter((q) =>
    q.query.includes('message_performance'),
  );
  assert.deepEqual(
    queries.map((q) => q.params.campaign_id),
    ['c1', 'c2', 'c3'],
  );
  assert.ok(
    queries.every(
      (q) =>
        q.query.includes("report_kind='campaign' AND entity_id=@campaign_id") &&
        q.query.includes('QUALIFY ROW_NUMBER()') &&
        q.query.includes('DATE_TRUNC'),
    ),
  );
  assert.ok(f.queryCalls.every((q) => q.maximumBytesBilled === 1_000_000_000));
});
test('drafts, scheduled unsent, flows, future sends and message variants never change the selected IDs', async () => {
  const c = campaign(1),
    f = fixture({
      candidates: [
        campaign(3),
        campaign(2),
        { ...c, message_id: 'm1' },
        { ...c, message_id: 'm2' },
        { ...campaign(0), entity_id: 'draft', status: 'draft' },
        {
          ...campaign(0),
          entity_id: 'scheduled',
          status: 'scheduled',
          is_sent: false,
        },
        { ...campaign(0), entity_id: 'flow', entity_kind: 'flow' },
        {
          ...campaign(0),
          entity_id: 'future',
          send_time: '2026-10-10T00:00:00Z',
        },
      ],
    });
  verify(await send(f, null), f);
});
test('previous three and comparison retain independent scope without overlapping identities', async () => {
  const f = fixture(),
    r = await send(f, null),
    previous = await send(f, r.context, 'What about the previous three?');
  assert.deepEqual(
    previous.evidence.campaigns.map((c) => c.entity_id),
    ['c4', 'c5', 'c6'],
  );
  assert.equal(previous.context.campaign_request.offset, 3);
  const comparison = await send(
    f,
    r.context,
    'Compare them with the three before.',
  );
  assert.deepEqual(
    comparison.evidence.campaigns.map((c) => c.entity_id),
    ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'],
  );
  assert.equal(
    comparison.evidence.sections.filter((s) => s.comparison).length,
    3,
  );
  assert.equal(
    new Set(comparison.evidence.campaigns.map((c) => c.entity_id)).size,
    6,
  );
});
test('independent failure, unsupported metrics and fewer available campaigns remain visible', async () => {
  const f = fixture({ candidates: [campaign(1), campaign(2)], failId: 'c2' }),
    r = await send(f, null);
  assert.equal(r.evidence.rows.length, 1);
  assert.match(r.answer, /Only 2 of 3/);
  assert.match(r.answer, /Campaign attribution retrieval failed/);
  assert.match(r.answer, /Unavailable/);
  assert.equal(r.evidence.sections[1].rows.length, 0);
});
test('unsupported provider fields remain unavailable and currencies are separate', async () => {
  const f = fixture(),
    original = f.provider;
  f.provider = async (n, a) => {
    const result = await original(n, a);
    delete result.rows[0].delivered;
    delete result.rows[0].unique_click_rate;
    result.rows.push({
      ...result.rows[0],
      currency: 'USD',
      conversion_metric_id: 'unknown',
      metric_provenance: 'unknown',
    });
    return result;
  };
  f.provider.resolveCampaigns = original.resolveCampaigns;
  f.baseline = createBaselineOverviewService({ klaviyo: f.provider });
  const r = await send(f, null);
  assert.equal(r.evidence.rows.length, 6);
  assert.match(r.answer, /GBP \/ placed/);
  assert.match(r.answer, /USD \/ unknown/);
  assert.match(r.answer, /Unavailable/);
});
test('multiple accounts/channels ask targeted options; selection retains count and since-send mode', async () => {
  const f = fixture({
    candidates: [
      campaign(1),
      campaign(2),
      campaign(3),
      { ...campaign(4), account: 'US', channel: 'sms' },
    ],
  });
  let r = await send(f, null);
  assert.match(r.answer, /Which campaign account\/channel/);
  assert.match(r.answer, /Account US, channel sms/);
  assert.equal(f.calls.length, 0);
  r = await send(f, r.context, '1');
  verify(r, f);
  assert.equal(r.context.campaign_request.account, 'production');
});
test('just emails disambiguates channels and preserves count', async () => {
  const f = fixture({
    candidates: [
      campaign(1),
      campaign(2),
      campaign(3),
      { ...campaign(4), channel: 'sms' },
    ],
  });
  let r = await send(f, null);
  r = await send(f, r.context, 'Just emails.');
  verify(r, f);
  assert.ok(f.calls.every((c) => c.args.campaign_channel === 'email'));
});
for (const type of ['missing', 'incomplete', 'conflicting'])
  test(`${type} send metadata cannot establish newest sent ordering`, async () => {
    const candidates = [campaign(1), campaign(2), campaign(3)];
    if (type === 'missing')
      candidates.push({ ...campaign(4), send_time: null });
    if (type === 'conflicting')
      candidates.push({ ...campaign(1), send_time: campaign(2).send_time });
    if (type === 'tied')
      candidates.push({ ...campaign(4), send_time: campaign(3).send_time });
    const f = fixture({ candidates });
    if (type === 'incomplete')
      f.provider.resolveCampaigns = async () => ({
        candidates,
        complete: false,
      });
    const r = await send(f, null);
    assert.match(r.answer, /names or identifiers|identifiers/);
    assert.doesNotMatch(r.answer, /What date range/);
    assert.equal(f.calls.length, 0);
  });
test('newest campaign outside supported cutoff retains older successful rows', async () => {
  const f = fixture({
      candidates: [
        { ...campaign(1), send_time: '2026-10-08T10:00:00Z' },
        campaign(2),
        campaign(3),
      ],
    }),
    r = await send(f, null);
  assert.deepEqual(
    f.calls.map((c) => c.args.campaign_id),
    ['c2', 'c3'],
  );
  assert.match(r.answer, /Sent after the supported reporting cutoff/);
  assert.equal(r.evidence.sections.length, 3);
});
test('explicit dates take precedence and subsequent date refinement clears native windows', async () => {
  const f = fixture(),
    r = await send(f, null, QUESTION + ' From 2026-08-01 to 2026-09-30.');
  assert.ok(f.calls.every((c) => c.args.start_date === '2026-08-01'));
  const refined = await send(f, r.context, 'For September 2026.');
  assert.ok(f.calls.slice(-3).every((c) => c.args.start_date === '2026-09-01'));
  assert.equal(refined.context.campaign_request.date_mode, null);
});
test('best, clicks and export reuse selected evidence and validate workbook bytes', async () => {
  const f = fixture(),
    r = await send(f, null),
    best = await send(f, r.context, 'Which did best?', { recent: r });
  assert.match(best.answer, /“Best” uses credited attributed revenue/);
  assert.equal(f.calls.length, 3);
  const clicks = await send(f, best.context, 'Show clicks too.', {
    recent: best,
  });
  assert.match(clicks.answer, /Unique clicks/);
  assert.equal(f.calls.length, 3);
  const exported = await send(f, clicks.context, 'Export that.', {
    recent: clicks,
    id: 'export',
  });
  assert.equal(f.calls.length, 3);
  assert.ok(exported.artifact);
  const saved = await f.exports.get(exported.artifact.id, 'owner');
  await assertProductArtifact(saved);
  assert.deepEqual(
    saved.analysis_context.campaign_request.selected_entities.map(
      (c) => c.entity_id,
    ),
    ['c1', 'c2', 'c3'],
  );
  const corrupt = structuredClone(saved);
  corrupt.envelope.rows[0].entity_id = 'other';
  await assert.rejects(
    assertProductArtifact(corrupt),
    (e) => e.code === 'EVIDENCE_SCOPE_MISMATCH',
  );
});
test('refresh and retry retain identities and windows; presentation recovery repeats no provider calls', async () => {
  const f = fixture(),
    r = await send(f, null),
    refresh = await send(
      f,
      JSON.parse(JSON.stringify(r.context)),
      'Refresh that.',
      { recent: r },
    );
  assert.equal(f.calls.length, 6);
  assert.deepEqual(
    refresh.evidence.reporting_windows,
    r.evidence.reporting_windows,
  );
  const recovered = deliverOracleResult(
    { ...refresh, answer: null, presentation: null },
    refresh.context,
  );
  assert.match(recovered.answer, /Campaign 1/);
  assert.equal(f.calls.length, 6);
  const retry = await send(f, refresh.context, 'Retry that request.');
  assert.deepEqual(retry.evidence.campaigns, r.evidence.campaigns);
  assert.equal(f.calls.length, 9);
});
test('subject switches and document mentions cannot retain or trigger campaign analysis', async () => {
  const f = fixture(),
    r = await send(f, null);
  for (const text of [
    'Show mobile and desktop conversion rates this year.',
    'Export pendants by units sold.',
    'Show shipping country sales this year.',
  ])
    assert.equal(apply(r.context, text).campaign_request, null);
  const text =
    'Summarize this document:\nDocument:\nHow did the last 3 Klaviyo campaigns go?';
  const result = await dispatchAnalysisRequest({
    message: text,
    analysisContext: r.context,
    baselineOverview: f.baseline,
    chat: async () => ({ answer: 'Document summary', tools: [] }),
  });
  assert.equal(result.answer, 'Document summary');
  assert.equal(f.calls.length, 3);
});
test('scope disagreement rejects changed IDs, windows and ordering', async () => {
  const f = fixture(),
    r = await send(f, null);
  for (const mutate of [
    (e) => e.campaigns.reverse(),
    (e) => (e.rows[0].entity_id = 'other'),
    (e) => (e.reporting_windows[0].start_date = '2020-01-01'),
  ]) {
    const e = structuredClone(r.evidence);
    mutate(e);
    assert.throws(
      () => assertEvidenceAgreement(r.context, e),
      (e) => e.code === 'EVIDENCE_SCOPE_MISMATCH',
    );
  }
  const submitted = apply(null, QUESTION);
  assert.throws(
    () =>
      assertResolvedAnalysisContext(submitted, {
        ...r.context,
        campaign_request: { ...r.context.campaign_request, count: 4 },
      }),
    (e) => e.code === 'EVIDENCE_SCOPE_MISMATCH',
  );
});
for (const durable of [false, true])
  for (const seed of [
    null,
    'Show mobile and desktop conversion rates this year.',
    'Export pendants by units sold.',
    'Show shipping country sales this year.',
    'Show Black Friday sales.',
  ])
    test(`real production factory ${durable ? 'durable' : 'interactive'} last-three delivery after ${seed || 'fresh'}`, async (t) => {
      const f = fixture({ production: true, live: true }),
        app = express(),
        jobs = createMemoryAnalysisJobStore();
      const baseline = async (message, options) =>
        options.analysisContext?.requested_subject === 'klaviyo_email'
          ? f.baseline(message, options)
          : { answer: 'Seed conversation', tools: [] };
      app.use(
        '/api/oracle',
        createOracleUiRouter({
          bigquery: {},
          project: 'fixture',
          knowledgeService: {},
          baselineOverview: baseline,
          chat: async () => assert.fail('No fallback'),
          analysisJobStore: jobs,
          exportStore: f.exports,
          generateProposals: async () => [],
          env: {
            ORACLE_UI_PASSWORD: 'password',
            ORACLE_UI_SESSION_SECRET: '12345678901234567890123456789012',
            ORACLE_UI_ADMIN_NAME: 'staff',
            ORACLE_ANALYSIS_JOBS_ENABLED: String(durable),
          },
          now: () => NOW,
        }),
      );
      const server = await new Promise((resolve, reject) => {
        const s = app.listen(0, '127.0.0.1');
        s.once('listening', () => resolve(s));
        s.once('error', reject);
      });
      t.after(() => {
        server.closeAllConnections();
        server.close();
      });
      const base = `http://127.0.0.1:${server.address().port}/api/oracle`;
      const login = await fetch(base + '/auth/login', {
          method: 'POST',
          headers: {
            origin: new URL(base).origin,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ password: 'password' }),
        }),
        auth = await login.json(),
        cookie = login.headers
          .getSetCookie()
          .map((v) => v.split(';')[0])
          .join('; '),
        headers = {
          cookie,
          origin: new URL(base).origin,
          'content-type': 'application/json',
          'x-csrf-token': auth.csrf,
        };
      let serial = 0;
      const submit = async (message, id = `entity-${++serial}`) => {
        let r = await (
          await fetch(base + `/${durable ? 'jobs' : 'chat'}`, {
            method: 'POST',
            headers: { ...headers, 'x-request-id': id },
            body: JSON.stringify({ message }),
          })
        ).json();
        if (durable) {
          const jobId = r.job_id;
          assert.ok(jobId, JSON.stringify(r));
          for (let i = 0; i < 300; i++) {
            r = await (
              await fetch(base + '/jobs/' + jobId, { headers: { cookie } })
            ).json();
            if (['completed', 'failed'].includes(r.status)) break;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          assert.equal(r.status, 'completed', JSON.stringify(r));
        }
        return r;
      };
      if (seed) await submit(seed);
      const r = await submit(QUESTION, 'original');
      verify({ ...r, context: r.analysis_context }, f);
      assert.equal(r.success, true);
      const latest = await (
        await fetch(base + '/analysis/latest', { headers: { cookie } })
      ).json();
      assert.deepEqual(
        latest.analysis.evidence.campaigns.map((c) => c.entity_id),
        ['c1', 'c2', 'c3'],
      );
      if (durable) {
        const recovery = await (
          await fetch(base + '/jobs/' + r.job_id, { headers: { cookie } })
        ).json();
        assert.deepEqual(recovery.evidence, r.evidence);
        const replay = await submit(QUESTION, 'original');
        assert.equal(replay.job_id, r.job_id);
        assert.equal(f.calls.length, 3);
      }
      const best = await submit('Which did best?', 'best');
      assert.match(best.answer, /“Best” uses/);
      const clicks = await submit('Show clicks too.', 'clicks');
      assert.match(clicks.answer, /Unique clicks/);
      assert.equal(f.calls.length, 3);
      const exported = await submit('Export that.', 'export');
      assert.ok(exported.artifact, JSON.stringify(exported));
      assert.equal(f.calls.length, 3);
      const download = await fetch(base + `/exports/${exported.artifact.id}`, {
        headers: { cookie },
      });
      assert.equal(download.status, 200);
      assert.match(
        download.headers.get('content-disposition'),
        /oracle-klaviyo-campaigns.xlsx/,
      );
      assert.ok((await download.arrayBuffer()).byteLength > 1000);
      const manifest = await (
        await fetch(base + `/exports/${exported.artifact.id}/manifest`, {
          headers: { cookie },
        })
      ).json();
      assert.deepEqual(
        manifest.evidence.campaigns.map((c) => c.entity_id),
        ['c1', 'c2', 'c3'],
      );
      if (durable) {
        const savedJob = jobs.jobs.get(exported.job_id);
        savedJob.status = 'failed';
        savedJob.error_code = 'WORKER_RESTARTED';
        savedJob.result_json = null;
        const recovered = await (
          await fetch(base + '/jobs/' + exported.job_id, {
            headers: { cookie },
          })
        ).json();
        assert.equal(recovered.recovered_persisted_export, true);
        assert.equal(recovered.status, 'completed');
        assert.deepEqual(
          recovered.evidence.campaigns.map((c) => c.entity_id),
          ['c1', 'c2', 'c3'],
        );
        assert.equal(f.calls.length, 3);
      }
    });
for (const phrase of [
  'Show the last three sent Klaviyo campaigns.',
  'How did the three most recently sent Klaviyo campaigns perform?',
  'Show the 3 latest Klaviyo campaigns.',
])
  test(`sent-selection paraphrase ${phrase}`, async () => {
    const f = fixture();
    verify(await send(f, null, phrase), f);
  });
test('bounded count clarification and explicit provider switches never invent source support', async () => {
  const f = fixture(),
    r = await send(f, null, 'How did the last 100 Klaviyo campaigns go?');
  assert.match(r.answer, /between 1 and 10/);
  assert.equal(f.calls.length, 0);
  for (const phrase of [
    'How did the last 3 campaigns on Meta go?',
    'How did the latest campaign on Facebook do?',
  ])
    assert.equal(apply(null, phrase).campaign_request, null);
});
test('single selected campaign follows ranking and export without selecting a different ID', async () => {
  const f = fixture(),
    r = await send(f, null, 'How did the latest campaign do?');
  assert.equal(r.evidence.campaign.entity_id, 'c1');
  const best = await send(f, r.context, 'Which did best?');
  assert.match(best.answer, /“Best” uses/);
  assert.deepEqual(
    best.evidence.campaigns.map((c) => c.entity_id),
    ['c1'],
  );
  const exported = await send(f, best.context, 'Export that.', {
    recent: best,
    id: 'single-export',
  });
  assert.ok(exported.artifact);
  assert.deepEqual(
    exported.evidence.campaigns.map((c) => c.entity_id),
    ['c1'],
  );
});
test('bounded campaign diagnostic defaults to no network and returns sanitized aggregate scope', async () => {
  let output = '';
  const preview = await campaignDiagnostic({
    env: { GOOGLE_SERVICE_ACCOUNT_JSON: 'private-credential' },
    argv: [],
    write: (v) => (output += v),
    clientFactory: () => assert.fail('No network in preview'),
  });
  assert.equal(preview.executed, false);
  assert.doesNotMatch(output, /private-credential/);
  const f = fixture();
  output = '';
  const result = await campaignDiagnostic({
    env: { GOOGLE_PROJECT_ID: 'fixture' },
    argv: ['--execute-read-only'],
    write: (v) => (output += v),
    now: () => NOW,
    clientFactory: () => ({ bigquery: f.bq, project: 'fixture' }),
  });
  assert.equal(result.queries, 7);
  assert.deepEqual(result.selected_campaign_ids, ['c1', 'c2', 'c3']);
  assert.equal(result.returned_rows, 3);
  assert.doesNotMatch(output, /Campaign 1|credentials|raw customer/);
  assert.ok(f.queryCalls.every((q) => /^(?:WITH|SELECT)\b/.test(q.query)));
});
test('since-send refinement replaces prior explicit calendar windows while explicit dates in the same request win', async () => {
  const f = fixture(),
    r = await send(f, null, QUESTION + ' From 2026-08-01 to 2026-09-30.'),
    since = await send(f, r.context, 'Since it was sent.');
  assert.equal(since.context.start_date, null);
  assert.deepEqual(
    f.calls.slice(-3).map((c) => c.args.start_date),
    ['2026-09-29', '2026-09-28', '2026-09-27'],
  );
  const explicit = await send(
    f,
    null,
    'Show the last 3 Klaviyo campaigns since sending from 2026-09-01 to 2026-09-30.',
  );
  assert.ok(f.calls.slice(-3).every((c) => c.args.start_date === '2026-09-01'));
  assert.equal(explicit.context.campaign_request.date_mode, null);
});
test('original single-campaign persisted plans recover without relaxing identity or period validation', async () => {
  const f = fixture(),
    r = await send(f, null, 'How did the latest campaign do?'),
    legacy = structuredClone(r.evidence);
  legacy.analytical_plan = resolveAnalyticalPlan(r.context);
  for (const field of [
    'scope',
    'selected_entities',
    'comparison_entities',
    'reporting_windows',
  ])
    delete legacy.analytical_plan.entities[field];
  assert.doesNotThrow(() => assertEvidenceAgreement(r.context, legacy));
  const corrupt = structuredClone(legacy);
  corrupt.analytical_plan.entities.selected.entity_id = 'wrong';
  assert.throws(
    () => assertEvidenceAgreement(r.context, corrupt),
    (e) => e.code === 'EVIDENCE_SCOPE_MISMATCH',
  );
  const pending = apply(null, 'How did the latest campaign do?');
  pending.campaign_request.date_mode = null;
  const restored = await dispatchAnalysisRequest({
    message: 'Retry that request.',
    analysisContext: pending,
    baselineOverview: f.baseline,
  });
  assert.doesNotMatch(restored.answer, /What date range/);
  assert.equal(restored.evidence.campaign.entity_id, 'c1');
});

// Revenue is a campaign measure, not an independent subject-switch signal.
test('attributed revenue ranking remains a compatible campaign refinement',async()=>{
  const f=fixture(),initial=await send(f,null);
  const ranked=await send(f,initial.context,'Which did best by attributed revenue?',{recent:initial});
  assert.equal(ranked.context.requested_subject,'klaviyo_email');
  assert.deepEqual(ranked.evidence.campaigns.map(c=>c.entity_id),initial.evidence.campaigns.map(c=>c.entity_id));
  assert.match(ranked.answer,/credited attributed revenue/);
  assert.equal(f.calls.length,3);
});

for (const direct of [true,false]) test(`production API pagination and static strategy resolve latest campaigns via ${direct?'direct':'shared'} delivery`,async()=>{
  const f=fixture({production:true,live:true});
  const r=await send(f,null,QUESTION,{direct});
  verify(r,f);
  assert.equal(f.discoveryCalls.length,2);
  assert.ok(f.discoveryCalls[0].url.includes('include=campaign-messages'));
  assert.ok(f.discoveryCalls[1].url.includes('page[cursor]=next'));
  assert.ok(f.queryCalls.every(q=>!q.query.includes('entity_metadata')));
  assert.match(r.presentation.summary_markdown,/30\.00 GBP/);
  assert.doesNotMatch(r.presentation.summary_markdown,/conversion_metric_id|exact post-send|Reporting cutoff/);
  const best=await send(f,r.context,'Which performed best?',{recent:r});
  assert.deepEqual(best.evidence.campaigns,r.evidence.campaigns);
  assert.equal(f.discoveryCalls.length,2);
  const exported=await send(f,best.context,'Export that.',{recent:best,id:'live-export'});
  assert.ok(exported.artifact);
  await assertProductArtifact(await f.exports.get(exported.artifact.id,'owner'));
});
test('send timestamp ties use stable campaign identity, including the selection boundary',async()=>{
  const candidates=[campaign(4),campaign(2),campaign(3),campaign(1)].map(c=>({...c,send_time:campaign(1).send_time}));
  const f=fixture({candidates,production:true,live:true});
  const r=await send(f,null);
  assert.deepEqual(r.evidence.campaigns.map(c=>c.entity_id),['c1','c2','c3']);
  const previous=await send(f,r.context,'Compare with the previous three.');
  assert.deepEqual(previous.evidence.campaigns.map(c=>c.entity_id),['c1','c2','c3','c4']);
});

test('live discovery preserves supported results through one actual performance provider failure',async()=>{
  const f=fixture({production:true,live:true,failId:'c2'});
  const r=await send(f,null);
  assert.deepEqual(r.evidence.campaigns.map(c=>c.entity_id),['c1','c2','c3']);
  assert.deepEqual(r.evidence.rows.map(c=>c.entity_id),['c1','c3']);
  assert.match(r.answer,/30\.00 GBP/);
  assert.match(r.answer,/unavailable|retrieval failed/i);
  assert.ok(f.queryCalls.some(q=>q.params?.campaign_id==='c2'));
});
test('production discovery missing metadata retains the guard and hides internal codes',async()=>{
  const f=fixture({production:true,live:true,candidates:[campaign(1),{...campaign(2),send_time:null},campaign(3)]});
  const r=await send(f,null);
  assert.equal(f.discoveryCalls.length,2);assert.equal(f.calls.length,0);
  assert.match(r.answer,/actual send timestamp/);
  assert.doesNotMatch(r.answer,/missing_send_metadata|What date range/);
});

test('single latest and ordinary recently-sent paraphrases use shared actual-send selection',async()=>{
 const f=fixture({production:true,live:true,candidates:[campaign(2),{...campaign(1),send_time:campaign(2).send_time},campaign(3)]});
 const single=await send(f,null,'How did the latest Klaviyo campaign perform?');
 assert.equal(single.evidence.campaign.entity_id,'c1');
 for(const question of ['How did the most recently sent 3 Klaviyo campaigns perform?','How did our three latest Klaviyo campaigns do?']) {
  const result=await send(f,null,question);
  assert.deepEqual(result.evidence.campaigns.map(c=>c.entity_id),['c1','c2','c3']);
 }
});
