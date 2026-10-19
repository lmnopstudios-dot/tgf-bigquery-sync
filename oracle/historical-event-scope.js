import { ONLINE_COUNTRY_SALES_SEMANTICS, SHOPIFY_NATIVE_HISTORY_START } from './online-country-sales.js';
// Validate producer observations, not a copy of the submitted analytical plan.
const fail=field=>{throw Object.assign(Error('Campaign evidence does not satisfy the requested scope.'),{code:'EVIDENCE_SCOPE_MISMATCH',failed_stage:'evidence_validation',scope_field:field});};
const key=p=>`${p?.event_id||p?.id}/${p?.start_date}/${p?.end_date}`;
const finite=x=>typeof x==='number'&&Number.isFinite(x);
export function assertHistoricalEventEvidence(context,evidence){
  const requested=evidence?.requested_scope,resolved=evidence?.resolved_scope;
  if(context.requested_subject!=='sales'||evidence?.kind!=='historical_event_comparison'||evidence.subject!=='sales')fail('event_subject');
  if(!Array.isArray(evidence.metrics)||evidence.metrics.length!==1||evidence.metrics[0]!=='sales'||context.metrics.some(metric=>!evidence.metrics.includes(metric)))fail('event_metrics');
  if(typeof requested?.event!=='string'||requested.event.toLowerCase()!==context.event_name?.toLowerCase()||requested?.count!==context.event_count)fail('event_selection');
  if(context.platform||context.geography||context.currencies?.length||context.filters?.length||context.channel_breakdown||requested.channel!=='online'||context.channel!=='online'||!requested.exclude_pos||!requested.exclude_matrixify||requested.currencies!=='separate'||requested.product_eligibility_filter!==false)fail('event_population');
  if(!resolved||!Array.isArray(resolved.expected_years)||resolved.requested_count!==requested.count||resolved.request_date!==requested.as_of||!/^\d{4}-\d{2}-\d{2}$/.test(requested.as_of)||!Array.isArray(resolved.events)||resolved.events.length>requested.count||!Array.isArray(evidence.sections)||evidence.sections.length!==resolved.events.length)fail('event_coverage');
  if(!Number.isFinite(Date.parse(evidence.requested_at)))fail('event_cutoff');
  if(evidence.requested_at&&new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(evidence.requested_at))!==requested.as_of)fail('event_cutoff');
  if(!Array.isArray(evidence.periods)||evidence.periods.length!==resolved.events.length||new Set(resolved.events.map(x=>x.id)).size!==resolved.events.length)fail('event_periods');
  const phaseIds=new Set();
  for(const ev of resolved.events){
    if(!ev||typeof ev.id!=='string')fail('event_identity');
    const duration=(Date.parse(ev.end_date+'T00:00:00Z')-Date.parse(ev.start_date+'T00:00:00Z'))/86400000+1;
    if(!Number.isInteger(duration)||duration<1||duration!==ev.duration_days||ev.end_date>=requested.as_of||!resolved.expected_years.includes(ev.year))fail('event_dates');
    if(!evidence.periods.some(p=>key(p)===key(ev)))fail('event_periods');
    if(![ev.name,...(ev.tags||[])].join(' ').toLowerCase().replaceAll('-',' ').includes(requested.event.toLowerCase().replaceAll('-',' ')))fail('event_identity');
    if(!Array.isArray(ev.phases)||!ev.phases.length)fail('event_phases');
    for(const phase of ev.phases){
      if(phaseIds.has(phase.id)||phase.start_date<ev.start_date||phase.end_date>ev.end_date||phase.start_date>phase.end_date||phase.provenance?.status!=='confirmed')fail('event_phases');
      phaseIds.add(phase.id);
    }
    const sections=evidence.sections.filter(s=>s.event?.id===ev.id);
    if(sections.length!==1||key(sections[0].event)!==key(ev))fail('event_identity');
    const section=sections[0];
    if(section.status==='rejected'){if(!section.error_code||section.report)fail('event_failure');continue;}
    if(section.status!=='fulfilled'||!section.report?.source_components?.length)fail('event_source_contract');
    const expectedSources=ev.end_date<SHOPIFY_NATIVE_HISTORY_START?['woo']:['woo','shopify'];
    if(section.report.source_components.length!==expectedSources.length||expectedSources.some(platform=>!section.report.source_components.some(c=>c.platform===platform)))fail('event_source_coverage');
    const sources=new Set();
    for(const component of section.report.source_components){
      if(!['woo','shopify'].includes(component.platform)||sources.has(component.platform))fail('event_source');
      sources.add(component.platform);
      if(component.status==='rejected'){if(!component.error_code||component.evidence)fail('event_failure');continue;}
      const actual=component.evidence;
      if(component.status!=='fulfilled'||actual?.period?.start_date!==ev.start_date||actual?.period?.end_date!==ev.end_date)fail('event_provider_period');
      if(actual.source_scope?.length!==1||actual.source_scope[0]!==component.platform||actual.currency_filter!==null||actual.semantics?.deduplication!==ONLINE_COUNTRY_SALES_SEMANTICS.deduplication||actual.semantics?.metric!==ONLINE_COUNTRY_SALES_SEMANTICS.metric||actual.semantics?.currency!==ONLINE_COUNTRY_SALES_SEMANTICS.currency||!Array.isArray(actual.rows))fail('event_provider_population');
      const totals=new Map();
      for(const row of actual.rows){
        if(!/^[A-Z]{3}$/.test(row.currency))fail('event_currency');
        for(const source of row.source_coverage||[]){
          const sourceKey=JSON.stringify([row.currency,source.source_platform,source.source_store]),values=JSON.stringify([source.eligible_orders,source.eligible_sales]);
          if(totals.has(sourceKey)&&totals.get(sourceKey)!==values)fail('event_duplicate_totals');totals.set(sourceKey,values);
          if(source.source_platform!==component.platform||typeof source.source_store!=='string'||!(component.platform==='shopify'?['shopify']:['ww','usd']).includes(source.source_store)||!Number.isSafeInteger(source.eligible_orders)||source.eligible_orders<0||!finite(Number(source.eligible_sales))||source.eligible_sales==null||source.eligible_sales===''||typeof source.eligible_sales==='boolean')fail('event_provider_population');
        }
      }
    }
    // Reconstruct presented rows from independently returned source contracts.
    const rows=section.report.source_components.filter(c=>c.status==='fulfilled').flatMap(c=>c.evidence.rows);
    if(JSON.stringify(rows)!==JSON.stringify(section.report.online_sales?.rows))fail('event_presented_rows');
  }
  return true;
}
