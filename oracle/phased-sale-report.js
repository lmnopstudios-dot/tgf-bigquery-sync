import {assertCountrySource} from './shopify-country-conversion.js';
import {saleInstant,nextSaleDay} from './sale-window-time.js';

const calendarPeriod = p => p.start_at===saleInstant(p.start_date) &&
  p.end_exclusive===saleInstant(nextSaleDay(p.end_date));
const sessionRequest = p => ({start_date:p.start_date,end_date:p.end_date,channel:'online',
  dimensions:[],population_scope:{geography_role:'visitor_country',country:null,groups:['global']}});

function validateSessionSource(period,source) {
  if (!calendarPeriod(period) || source.shop?.ianaTimezone!=='Europe/London' ||
      new Set(source.partitions?.map(p=>p.measurement_era)).size!==1) throw Error('Online sessions scope is not compatible');
  assertCountrySource(sessionRequest(period),source);
}

export async function phasedSaleSessions(reader,period,options) {
  if (!reader || !calendarPeriod(period)) return {status:'unavailable'};
  try {
    const source = await reader(sessionRequest(period),options);
    validateSessionSource(period,source);
    return {status:'fulfilled',source};
  } catch {
    return {status:'unavailable'};
  }
}

export function assertPhasedSaleSessions(scope,result,fail) {
  if (!scope.sessions) {
    if (result) fail();
    return;
  }
  if (!result || !['fulfilled','unavailable'].includes(result.status)) fail();
  if (result.status==='fulfilled') {
    try {validateSessionSource(scope.periods.find(p=>p.phase==='full'),result.source);}
    catch {fail();}
  } else if (result.source) fail();
}

function appendSessions(lines,period,sessionResult) {
  if (!sessionResult || !period.phase) return;
  if (sessionResult.status!=='fulfilled' || !calendarPeriod(period)) {
    lines.push('Online sessions and conversion unavailable. Comparable native session counts could not be verified for this window.');
    return;
  }
  const rows = sessionResult.source.partitions.flatMap(p=>p.rows).filter(r=>r.date>=period.start_date&&r.date<=period.end_date);
  const show = (name,sessions,numerator) =>
    `| ${name} | ${fmt(sessions)} | ${fmt(numerator)} | ${sessions>0?(100*numerator/sessions).toFixed(2)+'%':'Unavailable'} |`;
  lines.push('', 'Shopify Online Store human sessions across all visitor countries and currencies',
    '| London date or window | Sessions | Completed-checkout sessions | Session conversion |','|---|---:|---:|---:|');
  if (period.phase!=='full') for (const row of rows) lines.push(show(row.date,row.sessions,row.numerator));
  const days = 1+(Date.parse(period.end_date)-Date.parse(period.start_date))/86400000;
  if (rows.length===days) {
    lines.push(show('Window total',rows.reduce((n,r)=>n+r.sessions,0),rows.reduce((n,r)=>n+r.numerator,0)));
  } else lines.push('| Window total | Unavailable | Unavailable | Unavailable |');
  lines.push('', 'Conversion uses completed-checkout sessions divided by sessions within the same native scope. Tracking completeness is unverified.');
}

const numeric = v => v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null;
const fmt = v => numeric(v) == null ? 'Unavailable' : Number(v).toLocaleString('en-GB', {maximumFractionDigits: 2});
const label = channel => channel === 'online' ? 'Online Store' : 'POS';
const dateOf = r => r.date?.value || r.date;
const key = (date, currency) => JSON.stringify([date, currency]);
const md = value => String(value ?? '').replaceAll('|', '\\|').replace(/[\r\n]/g, ' ');

function metrics(section, totalsRows, daily = false) {
  const finance = daily ? section.daily : section.totals;
  const byKey = new Map();
  if (finance?.status === 'fulfilled') {
    for (const row of totalsRows(finance.evidence, section.window.channel, daily)) {
      const orders = numeric(row.orders);
      byKey.set(key(row.date || null, row.currency), {
        ...row, orders, sales:row.gross_sales == null ? null : row.sales,
        aov: orders > 0 && row.gross_sales != null ? row.gross_sales / orders : null
      });
    }
  }
  // Sum every qualifying product line group. A ranking has already dropped
  // products and is never a denominator or a substitute for total units.
  const product = section.products;
  if (product?.status === 'fulfilled') {
    for (const component of product.evidence.components.filter(c => c.status === 'fulfilled')) {
      for (const line of component.rows) {
        const date = daily ? dateOf(line) : null;
        const id = key(date, line.currency);
        const row = byKey.get(id) || {date, currency:line.currency};
        const units = line.missing_units ? null : numeric(line.units);
        row.units = units == null || row.units === null ? null : (row.units || 0) + units;
        byKey.set(id, row);
      }
    }
  }
  return [...byKey.values()].sort((a,b) =>
    String(a.date).localeCompare(String(b.date)) || String(a.currency).localeCompare(String(b.currency)));
}

function appendMetrics(lines, rows, {daily = false} = {}) {
  if (!rows.length) {
    lines.push('No qualifying observations are available for this section.');
    return;
  }
  lines.push('', '| '+(daily ? 'London date | ' : '')+'Currency | Gross sales incl. tax | Refunds (signed) | Sales after refunds | Orders | Units | Gross AOV |',
    (daily ? '|---' : '')+'|---|---:|---:|---:|---:|---:|---:|');
  for (const r of rows) {
    lines.push('| '+(daily ? r.date+' | ' : '')+[r.currency, r.gross_sales, r.refunds, r.sales, r.orders, r.units, r.aov]
      .map((v,i) => i === 0 ? md(v || 'Unknown') : fmt(v)).join(' | ')+' |');
  }
  lines.push('');
}

export function renderPhasedSale(evidence, totalsRows) {
  const {periods} = evidence.requested_scope.sale_scope;
  const lines = ['# '+periods.find(p=>p.phase==='full').name,
    'Observed native Shopify orders and refund events. Online Store and POS use recorded channels. Known Matrixify imports and unknown channels are excluded. Each currency is reported separately. Coverage is unverified.',
    'POS includes all recorded native Shopify POS locations in the supplied windows. Window membership alone does not establish use of a sale discount.',
    'Orders are unique eligible, non-cancelled orders with a successful sale or capture. Gross AOV is original order gross including tax and recorded discounts divided by those orders. Refunds use their own event dates. Units and product rankings use original sold line quantities and recorded discounted line sales before refund allocation.'];
  const summaries = new Map();
  for (const period of periods) {
    lines.push('', '## '+period.name, period.start_at+' ≤ transaction time < '+period.end_exclusive+' (Europe/London reporting dates).');
    for (const section of evidence.sections.filter(s => s.window.period_id === period.id)) {
      lines.push('', '### '+label(section.window.channel), ...section.window.limitations);
      const summary = metrics(section, totalsRows);
      summaries.set(section.window.id, summary);
      if (section.daily) {
        lines.push('Daily observations by London date');
        appendMetrics(lines, metrics(section, totalsRows, true), {daily:true});
        lines.push('Daily sales and refund amounts versus independent phase totals: '+section.reconciliation.status+'.');
        for (const row of section.reconciliation.rows || []) if (row.status === 'discrepancy') {
          lines.push(`${row.currency} ${row.transaction_type}: daily sum ${fmt(row.daily_sum)}, phase amount ${fmt(row.period_amount)}.`);
        }
      }
      lines.push(period.phase === 'full' ? 'Full-sale totals' : period.phase ? 'Phase totals' : 'Comparison period totals');
      appendMetrics(lines, summary);
      if(section.window.channel==='online')appendSessions(lines,period,evidence.online_sessions);
      for (const [name,result] of [['Daily',section.daily],['Period',section.totals],['Product',section.products]]) {
        if (!result) continue;
        if (result.status !== 'fulfilled') lines.push(name+' evidence unavailable ('+result.code+').');
        for (const c of result.evidence?.components || []) {
          if (c.status !== 'fulfilled') lines.push(name+' '+(c.measure || 'line')+' evidence unavailable ('+c.code+').');
        }
      }
      const products = section.products?.evidence?.rows || [];
      if (products.length) {
        lines.push('', 'Top '+section.window.product_limit+' products per currency by observed discounted line sales',
          '| Currency | Product | Units | Line sales |','|---|---|---:|---:|');
        for (const row of products) lines.push(`| ${md(row.currency)} | ${md(row.title || row.source_product_ref)} | ${fmt(row.units)} | ${fmt(row.sales)} |`);
        lines.push('', 'Product line amounts exclude shipping and use source tax semantics. Product-level refunds are unavailable.');
      }
    }
  }
  for (const period of periods.filter(p=>!p.phase)) {
    const [channel] = period.channels;
    const sale = periods.find(p=>p.phase==='full');
    const current = summaries.get(sale.id+':'+channel);
    const prior = summaries.get(period.id+':'+channel);
    lines.push('', '## '+label(channel)+' comparison with '+period.name);
    lines.push('The two windows use the same native channel, currency and metric definitions. Observed figures are shown side by side because collection completeness is unverified.');
    lines.push('| Currency | Metric | Full sale | '+period.name+' |','|---|---|---:|---:|');
    for (const currency of new Set([...current,...prior].map(r=>r.currency))) {
      const a=current.find(r=>r.currency===currency), b=prior.find(r=>r.currency===currency);
      for (const [field, name] of [['gross_sales','Gross sales'],['refunds','Refunds (signed)'],['sales','Sales after refunds'],['orders','Orders'],['units','Units'],['aov','Gross AOV']]) {
        lines.push(`| ${md(currency)} | ${name} | ${fmt(a?.[field])} | ${fmt(b?.[field])} |`);
      }
    }
    if (!current.length || !prior.length) lines.push('One or both comparison populations have no observed rows.');
  }
  return lines.join('\n');
}

export function assertPhasedSaleProducts(section, daily, fail) {
  if (section.products?.status !== 'fulfilled') return;
  const {window:w, products:{evidence:e}} = section;
  if (!Array.isArray(e.components) || e.components.length!==1 ||
      !['fulfilled','failed'].includes(e.components[0].status) ||
      e.components[0].source!=='shopify' ||
      (e.components[0].status==='fulfilled' && !Array.isArray(e.components[0].rows)) ||
      (e.components[0].status==='failed' && (e.components[0].rows?.length || e.rows.length))) fail();
  for (const row of e.components[0].rows || []) {
    const day=dateOf(row);
    if (row.namespace!=='shopify:shopify' || row.channel!==w.channel ||
        (daily && (!/^\d{4}-\d{2}-\d{2}$/.test(day || '') || day<w.start_date || day>w.end_date)) ||
        (!daily && day!=null)) fail();
  }
}
