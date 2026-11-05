import { stableAnalyticalJSON } from './analytical-plan.js';
export const normalizedSaleChannel = (c) =>
  /^online$/i.test(c)
    ? 'online'
    : /^(?:pos|in[- ]?store|retail)$/i.test(c)
      ? 'instore'
      : 'unknown';
const number = (v) =>
  v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null;
const key = (r) =>
  JSON.stringify([
    r.source,
    normalizedSaleChannel(r.channel),
    r.currency,
    r.transaction_type
  ]);
function sums(rows) {
  const out = new Map();
  for (const r of rows) {
    const k = key(r),
      prior = out.get(k),
      amount = number(r.amount);
    out.set(k, {
      source: r.source,
      channel: normalizedSaleChannel(r.channel),
      currency: r.currency,
      transaction_type: r.transaction_type,
      amount:
        prior === undefined
          ? amount
          : prior.amount == null || amount == null
            ? null
            : prior.amount + amount
    });
  }
  return out;
}
export function reconcileDailySales(daily, totals) {
  if (daily?.status !== 'fulfilled' || totals?.status !== 'fulfilled')
    return {
      status: 'unavailable',
      reason:
        'Independent daily and period reads are both required; successful reads are retained.'
    };
  const complete = [daily, totals].every(r => (r.evidence.components || []).every(c => c.status === 'fulfilled'));
  const a = sums(daily.evidence.rows),
    b = sums(totals.evidence.rows),
    rows = [];
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const d = a.get(k),
      t = b.get(k),
      delta =
        d?.amount != null && t?.amount != null
          ? Math.round((d.amount - t.amount) * 100) / 100
          : null;
    rows.push({
      ...(d || t),
      daily_sum: d?.amount ?? null,
      period_amount: t?.amount ?? null,
      difference: delta,
      status:
        delta == null ? 'unavailable' : delta === 0 ? 'matched' : 'discrepancy'
    });
  }
  return {
    status:
      complete && rows.length && rows.every((r) => r.status === 'matched')
        ? 'matched'
        : rows.some((r) => r.status === 'discrepancy')
          ? 'discrepancy'
          : 'unavailable',
    rows,
    reason:
      'Daily and period reads use identical source, eligibility, half-open bounds, channel, currency and transaction-date definitions. A difference indicates the two reads disagree; collection completeness and snapshot stability are unverified. Missing or failed refund evidence remains unavailable.'
  };
}
const fmt = (v) =>
  number(v) == null
    ? 'Unavailable'
    : Number(v).toLocaleString('en-GB', { maximumFractionDigits: 2 });
export function renderDailySales(section, groupRows) {
  const lines = [
    'Daily rows use London transaction dates. Refunds are dated by the refund event, not the original order. No period amount is allocated across days.'
  ];
  if (section.daily?.status !== 'fulfilled')
    lines.push(
      'Daily sales unavailable: ' +
        (section.daily?.code || 'EVENT_DAILY_UNAVAILABLE') +
        '.'
    );
  else {
    lines.push(
      '',
      '| London date | Phase | Source | Channel | Currency | Gross incl. tax | Refund value (signed) | Sales after refunds |',
      '|---|---|---|---|---|---:|---:|---:|'
    );
    for (const r of groupRows(
      section.daily.evidence,
      section.window.channel,
      true
    ).sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.channel.localeCompare(b.channel) ||
        a.currency.localeCompare(b.currency) ||
        a.source.localeCompare(b.source)
    )) {
      const phase = section.window.vip_date
        ? r.date === section.window.vip_date
          ? 'VIP'
          : 'Public'
        : '—';
      lines.push(
        `| ${r.date} | ${phase} | ${r.source} | ${r.channel} | ${r.currency} | ${fmt(r.gross_sales)} | ${fmt(r.refunds)} | ${fmt(r.sales)} |`
      );
    }
    lines.push('');
    if (!section.daily.evidence.rows.length)
      lines.push(
        'No daily observations returned; missing days are unavailable, not zero.'
      );
    for (const c of section.daily.evidence.components || [])
      if (c.status !== 'fulfilled')
        lines.push(`Daily ${c.source} ${c.measure} unavailable: ${c.code}.`);
  }
  lines.push('');
  const reconciliation = reconcileDailySales(section.daily, section.totals);
  lines.push(
    'Daily / period reconciliation: ' +
      reconciliation.status +
      '. ' +
      reconciliation.reason
  );
  if (reconciliation.rows?.length) {
    lines.push(
      '',
      '| Source | Channel | Currency | Component | Daily sum | Period evidence | Difference |',
      '|---|---|---|---|---:|---:|---:|'
    );
    for (const r of reconciliation.rows)
      lines.push(
        `| ${r.source} | ${r.channel} | ${r.currency} | ${r.transaction_type} | ${fmt(r.daily_sum)} | ${fmt(r.period_amount)} | ${fmt(r.difference)} |`
      );
  }
  lines.push('');
  return lines;
}
export function assertDailySales(section) {
  const fail = () => {
    throw Object.assign(Error('Daily sale evidence mismatch'), {
      code: 'EVIDENCE_SCOPE_MISMATCH'
    });
  };
  const d = section.daily,
    w = section.window;
  if (section.totals.status === 'fulfilled')
    assertReportRows(section.totals.evidence, w, fail);
  if (!d || !['fulfilled', 'failed'].includes(d.status)) fail();
  if (
    stableAnalyticalJSON(section.reconciliation) !==
    stableAnalyticalJSON(reconcileDailySales(d, section.totals))
  )
    fail();
  if (d.status !== 'fulfilled') return;
  const e = d.evidence;
  assertReportRows(e, w, fail);
  if (
    e.grain !== 'day' ||
    e.timezone !== 'Europe/London' ||
    e.definition !== 'timestamped_source_net_gross' ||
    stableAnalyticalJSON(e.period) !== stableAnalyticalJSON(w) ||
    !Array.isArray(e.rows) ||
    !Array.isArray(e.components) ||
    e.requires_refund_evidence !== true
  )
    fail();
  const seen = new Set();
  for (const r of e.rows) {
    const k = JSON.stringify([r.date, key(r)]),
      date = r.date?.value || r.date;
    if (
      typeof date !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      date < w.start_date ||
      date > w.end_date ||
      seen.has(k) ||
      normalizedSaleChannel(r.channel) !== w.channel ||
      !['sale', 'refund'].includes(r.transaction_type) ||
      (r.amount != null && number(r.amount) == null) ||
      !/^[A-Z]{3}$/.test(r.currency || '') ||
      !(
        w.source_selection === 'woo'
          ? /^WooCommerce (ww|usd)$/
          : /^Shopify (Online Store|POS|Unknown)$/
      ).test(r.source)
    )
      fail();
    seen.add(k);
  }
}

function assertReportRows(e, w, fail) {
  if (
    e.definition !== 'timestamped_source_net_gross' ||
    stableAnalyticalJSON(e.period) !== stableAnalyticalJSON(w) ||
    !Array.isArray(e.rows) ||
    !Array.isArray(e.components) ||
    e.requires_refund_evidence !== true
  )
    fail();
  const sources = w.source_selection === 'woo' ? ['ww', 'usd'] : ['shopify'];
  if (
    e.components.length !== sources.length * 2 ||
    new Set(e.components.map((c) => c.source + ':' + c.measure)).size !==
      e.components.length
  )
    fail();
  for (const c of e.components) {
    if (
      !sources.includes(c.source) ||
      !['sales', 'refunds'].includes(c.measure) ||
      !['fulfilled', 'failed', 'unavailable'].includes(c.status) ||
      !Array.isArray(c.rows) ||
      (c.status !== 'fulfilled' && c.rows.length)
    )
      fail();
    for (const r of c.rows) {
      const source =
        c.source === 'shopify'
          ? {
              online: 'Shopify Online Store',
              instore: 'Shopify POS',
              unknown: 'Shopify Unknown'
            }[w.channel]
          : 'WooCommerce ' + c.source;
      if (
        r.source !== source ||
        normalizedSaleChannel(r.channel) !== w.channel ||
        r.transaction_type !== (c.measure === 'sales' ? 'sale' : 'refund') ||
        (r.amount != null && number(r.amount) == null)
      )
        fail();
    }
  }
  if (
    stableAnalyticalJSON(e.components.flatMap((c) => c.rows)) !==
    stableAnalyticalJSON(e.rows)
  )
    fail();
}
