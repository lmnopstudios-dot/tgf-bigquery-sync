import ExcelJS from 'exceljs';
import { createHash } from 'node:crypto';
import { validateAnalysisContext } from './analysis-context.js';
import {
  resolveAnalyticalPlan,
  analyticalPlanKey,
  stableAnalyticalJSON,
  assertPlanAgreement,
} from './analytical-plan.js';
import { entityIdentity, selectSentEntities } from './entity-relative-scope.js';
import { evidenceNumber } from './numeric-evidence.js';
import { priorityArtifactId } from './product-priority-storage.js';

const day = (instant, zone) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(instant));
const esc = (v) =>
  String(v ?? 'Unavailable')
    .replaceAll('|', '\\|')
    .replace(/[\r\n<>]/g, ' ')
    .slice(0, 240);
const display = (v) =>
  evidenceNumber(v) == null
    ? 'Unavailable'
    : Number(v).toLocaleString('en-GB', { maximumFractionDigits: 2 });
export const campaignSetEntities = (r) => [
  ...r.selected_entities,
  ...r.comparison_entities,
];
export function assertCampaignSetEvidence(context, e) {
  const r = context.campaign_request,
    entities = campaignSetEntities(r),
    keys = entities.map(entityIdentity);
  const fail = () => {
    throw Object.assign(
      Error('Campaign set evidence differs from resolved scope'),
      { code: 'EVIDENCE_SCOPE_MISMATCH' },
    );
  };
  const same = (a, b) => stableAnalyticalJSON(a) === stableAnalyticalJSON(b);
  if (
    e.kind !== 'governed_klaviyo_campaign_set' ||
    !same(e.campaigns, entities) ||
    !same(e.reporting_windows, r.reporting_windows) ||
    new Set(keys).size !== keys.length
  )
    fail();
  if (
    e.selected_count !== r.selected_entities.length ||
    e.requested_count !== r.count ||
    e.selection_cutoff !== r.cutoff ||
    !same(e.requested_metrics, r.requested_metrics) ||
    (e.ranking_metric || null) !== (r.ranking_metric || null)
  )
    fail();
  if (
    !same(
      e.periods,
      r.reporting_windows.filter((w) => !w.unavailable),
    ) ||
    e.sections?.length !== keys.length
  )
    fail();
  for (const [i, section] of e.sections.entries()) {
    if (
      !same(section.campaign, entities[i]) ||
      !same(section.window, r.reporting_windows[i]) ||
      section.comparison !== i >= r.selected_entities.length
    )
      fail();
    for (const row of section.rows || [])
      if (entityIdentity(row) !== keys[i] || row.report_kind !== 'campaign')
        fail();
  }
  if (
    !same(
      e.rows,
      e.sections.flatMap((s) => s.rows),
    )
  )
    fail();
}
// A display/ranking refinement may reuse the same verified entity/window rows.
// Scope, identity and time changes never pass this projection.
export function compatibleCampaignEvidence(prior, context) {
  if (
    !context?.campaign_request?.reuse_evidence ||
    prior?.evidence?.kind !== 'governed_klaviyo_campaign_set' ||
    !prior.evidence.analytical_plan
  )
    return null;
  try {
    const previous = prior.analysis_context || prior.context;
    assertPlanAgreement(previous, prior.evidence);
    assertCampaignSetEvidence(previous, prior.evidence);
    const projection = (p) => {
      const copy = structuredClone(p);
      delete copy.presentation;
      delete copy.pending;
      delete copy.ranking;
      delete copy.metrics;
      return copy;
    };
    if (
      analyticalPlanKey(projection(resolveAnalyticalPlan(context))) ===
      analyticalPlanKey(projection(prior.evidence.analytical_plan))
    )
      return prior;
  } catch {}
  return null;
}
export function campaignSetBusinessView(e) {
  const lines = [
    `Selected ${e.selected_count} sent campaign(s), ordered by actual send timestamp (newest first), account ${esc(e.campaigns[0]?.account)}, channel ${esc(e.campaigns[0]?.channel)}. Evidence selection cutoff: ${esc(e.selection_cutoff)}.`,
    '| Campaign | Sent | Delivered | Click rate | Attributed purchases/conversions | Attributed revenue |' +
      (e.requested_metrics.includes('clicks') ? ' Unique clicks |' : ''),
    '|---|---|---:|---:|---:|---:|' +
      (e.requested_metrics.includes('clicks') ? '---:|' : ''),
  ];
  for (const s of e.sections) {
    const populations = s.rows.length ? s.rows : [{}];
    // Never combine currencies or conversion-metric populations. A campaign with
    // several native populations is one table row with separately labeled values.
    const values = (key) =>
      populations
        .map((r) => {
          const label =
            populations.length > 1
              ? `${esc(r.currency)} / ${esc(r.conversion_metric_id)}: `
              : '';
          let value = display(r[key]);
          if (key === 'unique_click_rate')
            value =
              evidenceNumber(r[key]) == null
                ? 'Unavailable'
                : display(Number(r[key]) * 100) + '%';
          if (key === 'attributed_conversion_value')
            value = /^[A-Z]{3}$/.test(r.currency || '')
              ? `${value} ${esc(r.currency)}`
              : 'Unavailable (currency not established)';
          return label + value;
        })
        .join('; ');
    lines.push(
      `| ${esc(s.campaign.entity_name || s.campaign.entity_id)}${s.comparison ? ' (previous group)' : ''} | ${esc(s.campaign.send_time)} | ${values('delivered')} | ${values('unique_click_rate')} | ${values('attributed_conversion_events')} | ${values('attributed_conversion_value')} |${e.requested_metrics.includes('clicks') ? ' ' + values('unique_clicks') + ' |' : ''}`,
    );
  }
  // Keep the entire Markdown table contiguous through the shared presenter.
  const tableEnd = 2 + e.sections.length;
  lines.splice(1, tableEnd, lines.slice(1, tableEnd + 1).join('\n'));
  lines.push(
    `Supported reporting cutoffs: ${[...new Set(e.campaigns.map((c) => c.reporting_cutoff || 'unavailable'))].map(esc).join(', ')}; report timezone(s): ${[...new Set(e.campaigns.map((c) => c.reporting_timezone || 'unavailable'))].map(esc).join(', ')}.`,
  );
  if (e.selection_gap)
    lines.push(
      `Only ${e.selected_count} of ${e.requested_count} requested sent campaigns were available; gap ${e.selection_gap}.`,
    );
  if (e.comparison_gap)
    lines.push(
      `The previous comparison group has ${e.comparison_gap} fewer campaigns than requested.`,
    );
  if (e.ranking_metric) {
    const populations = new Map();
    for (const s of e.sections.filter((s) => !s.comparison))
      for (const r of s.rows) {
        const key = JSON.stringify([
          r.currency,
          r.conversion_metric_id,
          r.reporting_timezone,
          r.api_revision,
          r.attribution_settings,
          r.report_period_semantics,
        ]);
        if (!populations.has(key)) populations.set(key, []);
        populations.get(key).push({ campaign: s.campaign, row: r });
      }
    lines.push(
      `“Best” uses ${e.ranking_metric === 'unique_click_rate' ? 'native unique click rate' : 'credited attributed revenue'}, separately for each currency and conversion-metric population; unequal attribution ages and unverified historical settings limit comparability.`,
    );
    for (const group of populations.values()) {
      const valid = group
        .filter(
          (x) =>
            evidenceNumber(x.row[e.ranking_metric]) != null &&
            x.row.conversion_metric_id &&
            (e.ranking_metric !== 'attributed_conversion_value' ||
              /^[A-Z]{3}$/.test(x.row.currency || '')),
        )
        .sort(
          (a, b) =>
            Number(b.row[e.ranking_metric]) - Number(a.row[e.ranking_metric]),
        );
      if (valid.length)
        lines.push(
          `Highest observed ${esc(e.ranking_metric)}: ${esc(valid[0].campaign.entity_name)} (${esc(valid[0].row.currency)} / ${esc(valid[0].row.conversion_metric_id)}). This is not a verified mature or incremental-performance winner.`,
        );
    }
  }
  lines.push(
    'Only calendar-month report windows are supported; exact post-send slicing and common elapsed-window comparisons are unavailable. Campaigns have different attribution ages; the newest can be provisional and is not equally mature.',
    'Revenue is Klaviyo credited conversion value, not incremental sales caused by email. Counts are native conversion-metric events; reviewed Placed Order provenance supports purchases, not distinct orders. Click rate is message-level unique clicks ÷ delivered messages.',
  );
  for (const s of e.sections) {
    if (s.unavailable)
      lines.push(
        `${esc(s.campaign.entity_name)}: ${esc(s.unavailable)}. Values are unavailable, not zero.`,
      );
    else if (!s.coverage?.complete)
      lines.push(
        `${esc(s.campaign.entity_name)}: reporting coverage is incomplete or unverified.`,
      );
  }
  return lines;
}
function campaignSetAnswer(e) {
  return [
    ...campaignSetBusinessView(e),
    '',
    '<details>',
    '<summary>Show details</summary>',
    'Opens are affected by privacy protections and machine activity, and do not verify readership.',
    ...e.sections.map(
      (s) =>
        `- ID ${esc(s.campaign.entity_id)}; ${esc(s.campaign.account)}/${esc(s.campaign.channel)}; requested report dates ${esc(s.window.start_date)} to ${esc(s.window.end_date)}; reporting timezone ${esc(s.campaign.reporting_timezone)}; supported cutoff ${esc(s.campaign.reporting_cutoff)}; latest retrieval ${esc(s.coverage?.latest_retrieved_at)}.\n${s.rows.map((r) => `  - ${esc(r.conversion_metric_id)} / ${esc(r.currency)}; actual windows ${esc(r.actual_start_date)} to ${esc(r.actual_end_date)}; settings ${esc(typeof r.attribution_settings === 'object' ? JSON.stringify(r.attribution_settings) : r.attribution_settings)}; definitions ${esc(r.metric_provenance)}. Stored settings do not prove historical applicability.`).join('\n')}`,
    ),
    '</details>',
  ].join('\n\n');
}
export async function answerCampaignSet({
  context,
  provider,
  onProviderStage,
  recentEvidence,
  exportStore,
  exportOwner,
  requestId,
}) {
  let request = structuredClone(context.campaign_request);
  const pending = (answer) => ({
    answer,
    tools: [],
    clarification: true,
    analysis_context: validateAnalysisContext({
      ...context,
      campaign_request: request,
    }),
  });
  if (
    request.selected &&
    request.count === 1 &&
    !request.selected_entities.length
  )
    request.selected_entities = [request.selected];
  if (
    !request.selected_entities.length ||
    (request.compare_previous && !request.metadata_attempted)
  ) {
    let listing;
    try {
      listing = await provider.resolveCampaigns({
        name: null,
        channel: request.channel,
        cutoff: request.cutoff,
      });
    } catch {
      listing = null;
    }
    if (!listing || listing.complete === false)
      return pending(
        'Campaign send metadata is unavailable or the listing is incomplete. Please provide campaign names or identifiers; latest sent ordering cannot be verified.',
      );
    const selection = selectSentEntities(listing.candidates || [], request);
    onProviderStage?.({
      stage: 'entity_selection',
      entity_type: 'campaign',
      selection_rule: request.selector,
      count: request.count,
      offset: request.offset,
      status: selection.blocker
        ? 'blocked'
        : selection.ambiguous
          ? 'ambiguous'
          : 'resolved',
      selected_count: selection.selected?.length || 0,
      required_dates: 0,
    });
    if (selection.blocker)
      return pending(
        `Campaign selection is blocked (${selection.blocker}). Please provide campaign names or identifiers; actual send ordering cannot be verified.`,
      );
    if (selection.ambiguous) {
      request.candidates = selection.ambiguous;
      request.metadata_attempted = true;
      return pending(
        'Which campaign account/channel should I use?\n\n' +
          selection.ambiguous
            .map(
              (c, i) =>
                `${i + 1}. Account ${esc(c.account)}, channel ${esc(c.channel)} (example ${esc(c.entity_name)}, ID ${esc(c.entity_id)})`,
            )
            .join('\n'),
      );
    }
    if (!selection.selected.length)
      return pending(
        'No verified sent campaigns are available for this selection. Please provide campaign names or identifiers.',
      );
    request.selected_entities = selection.selected;
    request.account = selection.selected[0].account;
    request.channel = selection.selected[0].channel;
    request.candidates = [];
    request.metadata_attempted = true;
    request.selection_gap = request.count - selection.selected.length;
    if (request.compare_previous) {
      const previous = selectSentEntities(listing.candidates || [], {
        ...request,
        offset: request.offset + request.count,
      });
      if (previous.blocker)
        return pending(
          `Previous campaign selection is blocked (${previous.blocker}); provide campaign identifiers.`,
        );
      request.comparison_entities = previous.selected || [];
    }
  }
  let entities = campaignSetEntities(request);
  if (!request.reporting_windows.length)
    request.reporting_windows = entities.map((c) => {
      const zone = c.reporting_timezone;
      if (!zone || !/^\d{4}-\d{2}-\d{2}$/.test(c.reporting_cutoff || ''))
        return {
          entity_id: c.entity_id,
          account: c.account,
          channel: c.channel,
          unavailable: 'Supported reporting timezone or cutoff unavailable',
        };
      const start =
        request.date_mode === 'since_send'
          ? day(c.send_time, zone)
          : context.start_date;
      const runtime = day(request.cutoff, zone),
        end =
          request.date_mode === 'since_send'
            ? [runtime, c.reporting_cutoff].sort()[0]
            : context.end_date;
      return {
        entity_id: c.entity_id,
        account: c.account,
        channel: c.channel,
        start_date: start,
        end_date: end,
        ...(start > end
          ? {
              unavailable:
                'Sent after the supported reporting cutoff; post-send attribution unavailable',
            }
          : {}),
      };
    });
  context = validateAnalysisContext({
    ...context,
    campaign_request: request,
    unresolved_required_fields: [],
  });
  request = context.campaign_request;
  entities = campaignSetEntities(request);
  const retained =
    compatibleCampaignEvidence(recentEvidence, context)?.evidence || null;
  const sections = [];
  for (const [i, c] of entities.entries()) {
    const window = request.reporting_windows[i],
      saved = retained?.sections[i];
    if (saved) {
      sections.push(saved);
      continue;
    }
    const section = {
      campaign: c,
      window,
      comparison: i >= request.selected_entities.length,
      rows: [],
      coverage: { complete: false },
    };
    if (window.unavailable) {
      section.unavailable = window.unavailable;
      sections.push(section);
      continue;
    }
    const args = {
      start_date: window.start_date,
      end_date: window.end_date,
      campaign_id: c.entity_id,
      campaign_account: c.account,
      campaign_channel: c.channel,
    };
    onProviderStage?.({
      stage: 'campaign_reporting',
      status: 'started',
      selection_index: i,
      required_dates: 0,
    });
    try {
      const result = await provider(context.tool_route, args);
      if (
        (result.rows || []).some(
          (r) => r.entity_id !== c.entity_id || r.report_kind !== 'campaign',
        )
      )
        throw Object.assign(Error('Campaign provider identity mismatch'), {
          code: 'EVIDENCE_SCOPE_MISMATCH',
        });
      section.rows = (result.rows || []).map((r) => ({
        ...r,
        account: c.account,
        channel: c.channel,
      }));
      section.coverage = result.coverage;
      section.definitions = result.definitions;
      section.component_failures = result.component_failures || [];
      section.limitations = result.limitations || [];
      if (result.success === false)
        section.unavailable = 'Attribution retrieval failed';
      if (!section.rows.length)
        section.unavailable ||=
          'No attribution rows returned; missing evidence does not establish zero';
    } catch (error) {
      if (error.code === 'EVIDENCE_SCOPE_MISMATCH') throw error;
      section.unavailable = 'Campaign attribution retrieval failed';
      section.component_failures = [
        { component: 'attribution', code: 'KLAVIYO_RETRIEVAL_FAILED' },
      ];
    }
    sections.push(section);
  }
  const evidence = {
    kind: 'governed_klaviyo_campaign_set',
    subject: 'klaviyo_email',
    metrics: context.metrics,
    analytical_plan: resolveAnalyticalPlan(context),
    email_report_kind: 'campaign',
    campaigns: entities,
    selection_cutoff: request.cutoff,
    selection_rule: request.selector,
    requested_count: request.count,
    selected_count: request.selected_entities.length,
    selection_gap: request.selection_gap,
    comparison_gap: request.compare_previous
      ? request.count - request.comparison_entities.length
      : 0,
    requested_metrics: request.requested_metrics,
    ranking_metric: request.ranking_metric,
    reporting_windows: request.reporting_windows,
    reporting_granularity: 'calendar_month',
    periods: request.reporting_windows.filter((w) => !w.unavailable),
    sections,
    rows: sections.flatMap((s) => s.rows),
    coverage: {
      complete: sections.every((s) => s.coverage?.complete && !s.unavailable),
    },
  };
  assertCampaignSetEvidence(context, evidence);
  let result = {
    answer: campaignSetAnswer(evidence),
    analysis_context: context,
    tools: [context.tool_route],
    evidence,
    partial: sections.some((s) => s.unavailable),
  };
  if (context.output_preference === 'xlsx')
    result = await exportCampaignSet(result, {
      exportStore,
      exportOwner,
      requestId,
    });
  return result;
}
export const campaignWorkbookRows = (e) =>
  e.sections.flatMap((s) =>
    (s.rows.length ? s.rows : [{}]).map((r) => ({
      campaign_id: s.campaign.entity_id,
      campaign: s.campaign.entity_name,
      account: s.campaign.account,
      channel: s.campaign.channel,
      sent: s.campaign.send_time,
      start_date: s.window.start_date || null,
      end_date: s.window.end_date || null,
      currency: r.currency || null,
      conversion_metric_id: r.conversion_metric_id || null,
      delivered: evidenceNumber(r.delivered),
      click_rate: evidenceNumber(r.unique_click_rate),
      clicks: evidenceNumber(r.unique_clicks),
      conversions: evidenceNumber(r.attributed_conversion_events),
      revenue: evidenceNumber(r.attributed_conversion_value),
      unavailable: s.unavailable || null,
    })),
  );
async function exportCampaignSet(
  result,
  { exportStore, exportOwner, requestId },
) {
  if (!exportStore || !exportOwner || !requestId)
    return {
      ...result,
      answer:
        result.answer +
        '\nExport storage is unavailable; campaign evidence is retained.',
    };
  const id = priorityArtifactId(exportOwner, requestId);
  try {
    const saved = await exportStore.get(id, exportOwner);
    if (saved) {
      assertCampaignSetEvidence(result.analysis_context, saved.envelope);
      if (
        analyticalPlanKey(saved.envelope.analytical_plan) !==
        analyticalPlanKey(result.evidence.analytical_plan)
      )
        throw Object.assign(Error('Export plan differs'), {
          code: 'EVIDENCE_SCOPE_MISMATCH',
        });
      return {
        ...result,
        artifact: {
          id,
          filename: saved.filename,
          row_count: saved.envelope.rows.length,
          download_url: `/api/oracle/exports/${id}`,
        },
      };
    }
    const wb = new ExcelJS.Workbook(),
      sheet = wb.addWorksheet('Campaigns'),
      rows = campaignWorkbookRows(result.evidence),
      keys = Object.keys(rows[0]);
    sheet.addRow(keys);
    rows.forEach((r) => sheet.addRow(keys.map((k) => r[k])));
    wb.addWorksheet('Definitions').addRow([result.answer]);
    const bytes = Buffer.from(await wb.xlsx.writeBuffer()),
      filename = 'oracle-klaviyo-campaigns.xlsx';
    await exportStore.put(id, exportOwner, {
      answer: result.answer,
      analysis_context: result.analysis_context,
      envelope: result.evidence,
      filename,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      xlsx_base64: bytes.toString('base64'),
    });
    return {
      ...result,
      artifact: {
        id,
        filename,
        row_count: result.evidence.rows.length,
        download_url: `/api/oracle/exports/${id}`,
      },
    };
  } catch (error) {
    if (error.code === 'EVIDENCE_SCOPE_MISMATCH') throw error;
    return {
      ...result,
      answer:
        result.answer +
        '\nThe spreadsheet could not be saved. Retrieved campaign evidence is retained.',
    };
  }
}
