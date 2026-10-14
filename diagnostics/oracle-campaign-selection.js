import { pathToFileURL } from 'node:url';
import { createBigQueryClient } from '../bigquery/client.js';
import { createOracleProviderDependencies } from '../oracle/provider-dependencies.js';
import { transitionAnalysisContext } from '../oracle/analysis-context.js';
import { createBaselineOverviewService } from '../oracle/baseline-overview.js';
import { dispatchAnalysisRequest } from '../oracle/analysis-route-dispatcher.js';

// Explicitly bounded SELECT-only probe. Default mode performs no remote reads.
const timeout = async (work, ms) => {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              Object.assign(Error('Diagnostic deadline'), {
                code: 'DIAGNOSTIC_DEADLINE',
              }),
            ),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
export async function main({
  env = process.env,
  argv = process.argv.slice(2),
  clientFactory = createBigQueryClient,
  write = (v) => process.stdout.write(v),
  now = () => Date.now(),
} = {}) {
  const bounds = {
    maximum_queries: 7,
    maximum_bytes_per_query: 1_000_000_000,
    per_call_deadline_ms: 15_000,
    total_deadline_ms: 60_000,
    selection_count: 3,
  };
  if (!argv.includes('--execute-read-only')) {
    const plan = {
      read_only: true,
      executed: false,
      ...bounds,
      required_configuration: [
        'GOOGLE_PROJECT_ID',
        'GOOGLE_SERVICE_ACCOUNT_JSON or configured application-default credentials',
      ],
      reads: [
        'sent entity metadata and supported coverage cutoff',
        'three scoped attribution and coverage reads',
      ],
      excluded: [
        'collection',
        'backfill',
        'inventory',
        'source or knowledge writes',
        'schedule changes',
        'deployment',
      ],
    };
    write(JSON.stringify(plan) + '\n');
    return plan;
  }
  if (!env.GOOGLE_PROJECT_ID)
    throw Object.assign(Error('Project selection required'), {
      code: 'PROJECT_SELECTION_REQUIRED',
    });
  const { bigquery, project } = clientFactory(env),
    started = now();
  let queries = 0;
  const stages = [];
  const remaining = () =>
    Math.max(0, bounds.total_deadline_ms - (now() - started));
  const guarded = {
    dataset: (name) => ({
      getMetadata: () =>
        timeout(
          () => bigquery.dataset(name).getMetadata(),
          Math.min(bounds.per_call_deadline_ms, remaining()),
        ),
    }),
    query: async (options) => {
      if (
        ++queries > bounds.maximum_queries ||
        remaining() <= 0 ||
        !/^\s*(?:SELECT|WITH)\b/i.test(options.query) ||
        options.maximumBytesBilled > bounds.maximum_bytes_per_query
      )
        throw Object.assign(Error('Diagnostic bound exceeded'), {
          code: 'DIAGNOSTIC_BOUND',
        });
      return timeout(
        () =>
          bigquery.query({
            ...options,
            maximumBytesBilled: bounds.maximum_bytes_per_query,
          }),
        Math.min(bounds.per_call_deadline_ms, remaining()),
      );
    },
  };
  const provider = createOracleProviderDependencies({
    bigquery: guarded,
    project,
    env: {},
  }).klaviyo;
  const context = transitionAnalysisContext(
    null,
    'How did the last 3 Klaviyo campaigns go?',
    { now: started },
  ).context;
  const result = await dispatchAnalysisRequest({
    message: 'How did the last 3 Klaviyo campaigns go?',
    analysisContext: context,
    baselineOverview: createBaselineOverviewService({ klaviyo: provider }),
    baselineOptions: {
      onProviderStage: (event) => {
        if (stages.length < 20)
          stages.push(
            Object.fromEntries(
              [
                'stage',
                'status',
                'selection_rule',
                'count',
                'offset',
                'selected_count',
                'selection_index',
                'required_dates',
              ]
                .filter((k) => event[k] != null)
                .map((k) => [k, event[k]]),
            ),
          );
      },
    },
  });
  const evidence = result.evidence;
  const summary = {
    read_only: true,
    executed: true,
    ...bounds,
    queries,
    selected_campaign_ids: evidence?.campaigns.map((c) => c.entity_id) || [],
    reporting_windows: evidence?.reporting_windows || [],
    selection_cutoff: evidence?.selection_cutoff || null,
    reporting_granularity: evidence?.reporting_granularity || null,
    returned_rows: evidence?.rows.length || 0,
    complete: evidence?.coverage.complete === true,
    clarification: Boolean(result.clarification),
    unavailable_campaigns:
      evidence?.sections
        .filter((s) => s.unavailable)
        .map((s) => ({
          campaign_id: s.campaign.entity_id,
          unavailable: s.unavailable,
        })) || [],
    stages,
  };
  write(JSON.stringify(summary) + '\n');
  return summary;
}
if (import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    const code = [
      'PROJECT_SELECTION_REQUIRED',
      'DIAGNOSTIC_BOUND',
      'DIAGNOSTIC_DEADLINE',
      'EVIDENCE_SCOPE_MISMATCH',
    ].includes(error.code)
      ? error.code
      : 'CAMPAIGN_DIAGNOSTIC_FAILED';
    process.stderr.write(JSON.stringify({ read_only: true, code }) + '\n');
    process.exitCode = 1;
  });
