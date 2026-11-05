import { saleInstant, nextSaleDay } from './sale-window-time.js';
import { validSaleDay } from './sale-window-scope.js';
const invalid = () => {
  throw Object.assign(Error('Invalid independent sale periods'), {
    code: 'INVALID_ANALYSIS_CONTEXT'
  });
};
const months = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec'
];
const date = (d, m, y) =>
  `${y}-${String(months.indexOf(m.toLowerCase().slice(0, 3)) + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
export function validateSalePeriods(periods) {
  if (!Array.isArray(periods) || !periods.length || periods.length > 5)
    invalid();
  const ids = new Set();
  for (const p of periods) {
    if (
      !p ||
      Object.keys(p).some(
        (k) =>
          ![
            'id',
            'name',
            'start_date',
            'end_date',
            'start_at',
            'end_exclusive',
            'source',
            'channels',
            'vip_date'
          ].includes(k)
      ) ||
      typeof p.id !== 'string' ||
      ids.has(p.id) ||
      !p.name ||
      p.name.length > 100 ||
      !validSaleDay(p.start_date) ||
      !validSaleDay(p.end_date) ||
      p.start_date > p.end_date ||
      Date.parse(p.end_date) - Date.parse(p.start_date) > 92 * 86400000 ||
      !['woo', 'shopify'].includes(p.source) ||
      !Array.isArray(p.channels) ||
      !p.channels.length ||
      new Set(p.channels).size !== p.channels.length ||
      p.channels.some((c) => !['online', 'instore', 'unknown'].includes(c)) ||
      (p.source === 'woo' && p.channels.some((c) => c !== 'online')) ||
      !Number.isFinite(Date.parse(p.start_at)) ||
      !Number.isFinite(Date.parse(p.end_exclusive)) ||
      p.end_exclusive <= p.start_at
    )
      invalid();
    const london = (t) =>
      new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(
        new Date(t)
      );
    if (
      london(p.start_at) !== p.start_date ||
      london(Date.parse(p.end_exclusive) - 1) !== p.end_date ||
      (p.vip_date != null &&
        (!validSaleDay(p.vip_date) ||
          p.vip_date < p.start_date ||
          p.vip_date > p.end_date))
    )
      invalid();
    ids.add(p.id);
  }
  return periods.map((p) => ({ ...p, channels: [...p.channels] }));
}
// Explicit numbered sale periods are independent populations. Never flatten their
// sources/channels into the Cartesian product used for annual event discovery.
export function explicitSalePeriods(text) {
  if (!/\bdaily\b|\bby (?:London )?date\b/i.test(text)) return null;
  const clauses = [
    ...text.replaceAll('**', '').matchAll(/(?:^|\n|\s)(\d)[.)]\s+([^\n]+)/g)
  ].map((m) => m[0].trim());
  if (
    clauses.length < 2 ||
    !clauses.every((c) => /\bsale|Black Friday|Bank Holiday/i.test(c))
  )
    return null;
  const periods = [];
  for (const clause of clauses) {
    const heading = clause.match(/^\d[.)]\s+([^:]+):/),
      year = heading?.[1].match(/20\d{2}/)?.[0];
    if (!heading || !year) return null;
    const body = clause.slice(heading[0].length);
    // Excluded sources do not select the period's provider.
    const population = body.split(/\b(?:exclude|excluding|except|without)\b/i)[0];
    const source = /\bWooCommerce\b/i.test(population)
      ? 'woo'
      : /\bShopify\b/i.test(population)
        ? 'shopify'
        : null;
    let start, end, start_at, end_exclusive;
    const exact = [
      ...body.matchAll(
        /\b(\d{1,2})\s+([a-z]+)\s+(20\d{2})\s+(?:at\s+)?(\d{1,2}:\d{2})\s*(GMT|UTC)\b/gi
      )
    ];
    if (exact.length === 2 && /exclusive/i.test(body)) {
      start = date(exact[0][1], exact[0][2], exact[0][3]);
      start_at = saleInstant(start, exact[0][4], 'UTC');
      end_exclusive = saleInstant(
        date(exact[1][1], exact[1][2], exact[1][3]),
        exact[1][4],
        'UTC'
      );
      end = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/London'
      }).format(new Date(Date.parse(end_exclusive) - 1));
    } else {
      const range = body.match(
        /\b(\d{1,2})\s*[-–—]\s*(\d{1,2})\s+([a-z]+)(?:\s+(20\d{2}))?\s+inclusive\b/i
      );
      if (!range) return null;
      start = date(range[1], range[3], range[4] || year);
      end = date(range[2], range[3], range[4] || year);
      start_at = saleInstant(start);
      end_exclusive = saleInstant(nextSaleDay(end));
    }
    const channels =
      source === 'shopify' && /split\s+Online Store\s*(?:\/|and)\s*POS/i.test(body)
        ? ['online', 'instore', 'unknown']
        : ['online'];
    if (!source || (channels.length === 1 && !/online/i.test(body)))
      return null;
    const vip = body.match(/(?:Label\s+)?(\d{1,2})\s+([a-z]+)\s+VIP/i);
    periods.push({
      id: `period-${periods.length + 1}`,
      name: heading[1].trim(),
      start_date: start,
      end_date: end,
      start_at,
      end_exclusive,
      source,
      channels,
      ...(vip ? { vip_date: date(vip[1], vip[2], year) } : {})
    });
  }
  return validateSalePeriods(periods);
}
export function resolveExplicitSalePeriods(scope, asOf) {
  return {
    windows: scope.periods.flatMap((p) =>
      p.channels.map((channel) => ({
        id: `${p.id}:${channel}`,
        period_id: p.id,
        name: p.name,
        year: Number(p.start_date.slice(0, 4)),
        channel,
        location_name: null,
        source_selection: p.source,
        ...(p.source === 'shopify'
          ? { shopify_channel: channel, pos_population: 'all_recorded' }
          : {}),
        start_date: p.start_date,
        end_date: p.end_date,
        start_at: p.start_at,
        end_exclusive: p.end_exclusive,
        timezone: 'Europe/London',
        timezone_provenance: 'explicit user request',
        time_precision: 'clock',
        intraday: true,
        time_basis:
          'explicit half-open requested period; grouped by London transaction date',
        ...(p.vip_date ? { vip_date: p.vip_date } : {}),
        knowledge_entries: [
          {
            id: p.id,
            kind: 'request',
            status: 'confirmed',
            title: p.name,
            effective_from: p.start_date,
            effective_to: p.end_date,
            source_reference: 'current user request',
            recorded_at: asOf
          }
        ],
        limitations: []
      }))
    ),
    issues: []
  };
}
