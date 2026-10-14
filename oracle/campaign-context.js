import { relativeEntitySelection } from './entity-relative-scope.js';
import { naturalReportPeriod } from './report-natural-period.js';

const bounded = (value) =>
  typeof value === 'string' ? value.slice(0, 240) : null;
export function validateCampaignRequest(value) {
  if (value == null) return null;
  if (
    !value ||
    typeof value !== 'object' ||
    !['latest', 'named', 'previous'].includes(value.selector)
  )
    throw new Error('Invalid campaign request');
  const candidate = (c) => {
    if (!c || typeof c.entity_id !== 'string' || !c.entity_id)
      throw new Error('Invalid campaign identity');
    return Object.fromEntries(
      [
        'entity_id',
        'entity_name',
        'account',
        'channel',
        'send_time',
        'send_time_semantics',
        'reporting_timezone',
        'reporting_cutoff',
        'retrieved_at',
      ].map((k) => [k, bounded(c[k])]),
    );
  };
  return {
    entity_type: 'campaign',
    source: 'klaviyo',
    ordering_basis: 'actual_send_time_desc',
    count:
      Number.isInteger(value.count) && value.count >= 1 && value.count <= 10
        ? value.count
        : 1,
    offset:
      Number.isInteger(value.offset) && value.offset >= 0 && value.offset <= 500
        ? value.offset
        : 0,
    account: bounded(value.account),
    selected_entities: (value.selected_entities || [])
      .slice(0, 20)
      .map(candidate),
    comparison_entities: (value.comparison_entities || [])
      .slice(0, 10)
      .map(candidate),
    reuse_evidence: Boolean(value.reuse_evidence),
    compare_previous: Boolean(value.compare_previous),
    selection_gap: Number.isInteger(value.selection_gap)
      ? value.selection_gap
      : 0,
    ranking_metric:
      value.ranking_metric === 'unique_click_rate'
        ? 'unique_click_rate'
        : value.ranking_metric === 'attributed_conversion_value'
          ? 'attributed_conversion_value'
          : null,
    reporting_windows: (value.reporting_windows || [])
      .slice(0, 20)
      .map((w) => ({
        entity_id: bounded(w.entity_id),
        account: bounded(w.account),
        channel: bounded(w.channel),
        start_date: bounded(w.start_date),
        end_date: bounded(w.end_date),
        unavailable: bounded(w.unavailable),
      })),
    selection_blocked: Boolean(value.selection_blocked),
    selector: value.selector,
    name: bounded(value.name),
    channel: bounded(value.channel),
    selected: value.selected ? candidate(value.selected) : null,
    candidates: (value.candidates || []).slice(0, 50).map(candidate),
    date_mode: value.date_mode === 'since_send' ? 'since_send' : null,
    metadata_attempted: Boolean(value.metadata_attempted),
    clarification_attempted: Boolean(value.clarification_attempted),
    send_date: bounded(value.send_date),
    cutoff: bounded(value.cutoff),
    requested_metrics: (
      value.requested_metrics || ['purchases', 'revenue']
    ).filter((x) =>
      ['purchases', 'revenue', 'clicks', 'delivered', 'click_rate'].includes(x),
    ),
  };
}
export const sinceSend = (text) =>
  /\b(?:since|from)\b[\s\S]{0,45}\b(?:sent|send|sending)\b/i.test(text);
export function campaignContextPatch(base, text, now) {
  if (/\b(?:meta|facebook|instagram|tiktok|google ads)\b/i.test(text))
    return null;
  const scope = relativeEntitySelection(text, {
    entityPattern: '(?:klaviyo\\s+)?(?:email(?:\\s+campaign)?s?|campaigns?)',
    continuation: Boolean(base.campaign_request),
    defaultCount: base.campaign_request?.count || 1,
  });
  const latest =
    /\b(?:last|latest|most recent)\s+(?:klaviyo\s+)?(?:email(?:\s+campaign)?|campaign)\b/i.test(
      text,
    );
  const named =
    text.match(
      /\bcampaign\s+(?:called|named)\s+["“]?([^"”?.]+)|\b["“]([^"”]+)["”]\s+(?:email\s+)?campaign\b/i,
    ) ||
    text.match(/\b(?:from|for)\s+([^?.]+?)\s+(?:email\s+)?campaign\b/i) ||
    text.match(/\bcampaign\s+["“]([^"”]+)["”]/i);
  const fresh = Boolean(
    latest ||
    named ||
    (scope && !base.campaign_request) ||
    (scope && /\bcampaigns?\b/i.test(text)),
  );
  const pending = base.campaign_request;

  if (!fresh && !pending) return null;
  // A new analytical subject must bypass pending clarification handling.
  if (
    !fresh &&
    /\b(?:sales|orders?|countries|abandoned?[- ]checkouts?|products?|conversion rates?|mobile|desktop|stock|inventory|flows?|customers?|shipping|sales by country|Black Friday)\b/i.test(
      text,
    )
  )
    return null;
  if (
    !fresh &&
    /\b(?:export|download)\b/i.test(text) &&
    !/\b(?:that|this|it|campaigns?)\b/i.test(text)
  )
    return null;
  const dates = naturalReportPeriod(text, now, {
    referenceYear: !fresh ? base.start_date?.slice(0, 4) : null,
  });
  const select = text.match(
    /^(?:(?:use|choose|pick|select)\s+)?(?:option\s+|choice\s+)?#?(\d+)\s*[.!]?$/i,
  );
  const matches = pending?.candidates.filter((c) =>
    [
      c.entity_id,
      c.entity_name,
      ...(pending.count > 1
        ? [c.account, c.channel, `${c.account} ${c.channel}`]
        : []),
    ].some((v) => v?.toLowerCase() === text.toLowerCase().replace(/[.!]$/, '')),
  );
  const exact = matches?.length === 1 ? matches[0] : null;
  const selected =
    exact || (select ? pending?.candidates[Number(select[1]) - 1] : null);
  const compatible =
    /\b(?:best|clicks?|emails?|export|download|retry|refresh|compare|previous|before)\b/i.test(
      text,
    );
  const continuation =
    !fresh &&
    (scope ||
      compatible ||
      sinceSend(text) ||
      dates ||
      selected ||
      matches?.length ||
      (pending?.metadata_attempted &&
        !pending.selected_entities?.length &&
        (!pending.selected || !pending.selected.send_time)));
  if (!fresh && !continuation) return null;
  const request = fresh
    ? {
        selector: scope?.rule || (latest ? 'latest' : 'named'),
        count: scope?.count || 1,
        offset: scope?.rule === 'previous' ? scope.count || 1 : 0,
        name:
          (named?.[1]?.trim() || named?.[2]?.trim() || '').replace(
            /\s+(?:since|from|during|for|in)\s+(?=20\d{2}|(?:it|sending|send)\b|(?:jan\w*|feb\w*|mar\w*|apr\w*|may|jun\w*|jul\w*|aug\w*|sep\w*|oct\w*|nov\w*|dec\w*)\s+20\d{2})[\s\S]*$/i,
            '',
          ) || null,
        channel: /\bemails?\b/i.test(text) ? 'email' : null,
        requested_metrics: ['purchases', 'revenue'],
        cutoff: new Date(now).toISOString(),
      }
    : structuredClone(pending);
  if (selected) {
    request.selected = selected;
    request.account = selected.account;
    request.channel = selected.channel;
    request.candidates = [];
    if (request.count > 1) {
      request.selected = null;
      request.selected_entities = [];
      request.metadata_attempted = false;
    }
  }
  if (!fresh && scope) {
    request.compare_previous = false;
    request.selector = 'previous';
    request.offset = (request.offset || 0) + (request.count || 1);
    request.count = scope.count;
    request.selected = null;
    request.selected_entities = [];
    request.comparison_entities = [];
    request.reporting_windows = [];
    request.metadata_attempted = false;
  }
  if (!fresh && /\bcompare\b/i.test(text) && /\bbefore\b/i.test(text)) {
    request.offset = pending.offset;
    request.selected = pending.selected;
    request.selected_entities = pending.selected_entities;
    request.compare_previous = true;
    request.metadata_attempted = false;
    request.comparison_entities = [];
    request.reporting_windows = [];
  }
  if (/\b(?:just|only)\s+emails?\b/i.test(text)) {
    request.channel = 'email';
    request.selected = null;
    request.selected_entities = [];
    request.comparison_entities = [];
    request.reporting_windows = [];
    request.metadata_attempted = false;
  }
  if (/\bclicks?\b/i.test(text))
    request.requested_metrics = [
      ...new Set([...request.requested_metrics, 'clicks']),
    ];
  if (/\bbest\b/i.test(text))
    request.ranking_metric = /\bclick\b/i.test(text)
      ? 'unique_click_rate'
      : 'attributed_conversion_value';
  if (dates) {
    request.date_mode = null;
    request.reporting_windows = [];
  }
  if (sinceSend(text) && !dates) {
    request.date_mode = 'since_send';
    request.reporting_windows = [];
  }
  if (
    !fresh &&
    dates &&
    /\b20\d{2}-\d{2}-\d{2}\b|\b\d{1,2}\s+(?:jan\w*|feb\w*|mar\w*|apr\w*|may|jun\w*|jul\w*|aug\w*|sep\w*|oct\w*|nov\w*|dec\w*)\s+20\d{2}\b/i.test(
      text,
    ) &&
    pending.metadata_attempted &&
    !pending.selected_entities?.length &&
    !pending.selected?.send_time
  ) {
    request.send_date = dates.start_date;
    request.date_mode = 'since_send';
  }
  if (
    !fresh &&
    !selected &&
    !dates &&
    !sinceSend(text) &&
    !compatible &&
    !scope &&
    !matches?.length &&
    pending.metadata_attempted
  ) {
    request.count = 1;
    request.offset = 0;
    request.selected_entities = [];
    request.reporting_windows = [];
    request.selector = 'named';
    request.name = text.replace(/[.!]$/, '');
    request.selected = null;
    request.candidates = [];
    request.metadata_attempted = false;
  }
  request.selection_blocked = Boolean(scope?.unsupported);
  request.reuse_evidence =
    !fresh &&
    compatible &&
    !/\b(?:retry|refresh|previous|before)\b/i.test(text);
  if (fresh && !dates) request.date_mode = 'since_send';
  const out = {
    ...(fresh ? {} : base),
    requested_subject: 'klaviyo_email',
    metrics: ['email_attribution'],
    analysis_type: 'ecommerce',
    platform: 'klaviyo',
    grain: 'month',
    email_report_kind: 'campaign',
    tool_route: 'get_klaviyo_email_performance',
    campaign_request: request,
    unresolved_required_fields: [],
    ...(dates || {}),
    ...(sinceSend(text) &&
    !dates &&
    (request.count > 1 || request.selected_entities?.length)
      ? {
          start_date: null,
          end_date: null,
          date_cutoff: null,
          current_day_included: false,
        }
      : {}),
    ...(/\b(?:export|download)\b/i.test(text)
      ? { output_preference: 'xlsx' }
      : {}),
  };
  return { patch: out, continuation: Boolean(continuation) };
}

/** Placed Order provenance establishes purchase events, never distinct orders. */
export const isCampaignPurchaseMetric = (row) =>
  /^(?:shopify|woocommerce):Placed Order(?:;|$)/i.test(
    row.metric_provenance || '',
  );
