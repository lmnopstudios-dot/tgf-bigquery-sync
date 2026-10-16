import test from 'node:test';
import assert from 'node:assert/strict';
import { datesBetween } from '../ga4/semantic.js';
import { createCountryConversionReportReader, countryReportWindows } from '../oracle/country-conversion-report.js';
import { createShopifyCountryConversionReader } from '../oracle/shopify-country-conversion.js';
import { transitionAnalysisContext } from '../oracle/analysis-context.js';
import { resolveAnalysisDecision } from '../oracle/analysis-decision.js';
import { answerPopulationConversion, assertPopulationConversionEvidence } from '../oracle/population-conversion.js';
import { answerCompleteness } from '../oracle/answer-completeness.js';
import { withOracleCharts } from '../oracle/evidence-charts.js';
import { assertCountryWorkbook } from '../oracle/country-conversion-export.js';
import { createBaselineOverviewService } from '../oracle/baseline-overview.js';
import { executeGovernedAgentAnalysis } from '../oracle/analysis-route-dispatcher.js';
const NOW=Date.parse('2026-10-16T12:00:00Z');
const context=(q,prior=null)=>transitionAnalysisContext(prior,q,{now:NOW}).context;
function fixture({failReport=null,zero=false,unknown=50}={}){
  const calls=[];
  const graphql=async(query,variables)=>{
    calls.push({query,variables});
    if(!variables?.query)return {shop:{id:'shop',ianaTimezone:'Europe/London'},currentAppInstallation:{accessScopes:[{handle:'read_reports'}]}};
    const sql=variables.query,[,start,end]=sql.match(/SINCE (\S+) UNTIL (\S+)/),local=sql.includes("session_country_code = 'GB'"),rest=sql.includes("session_country_code != 'GB'");
    if(failReport?.(start,end,sql))throw Error('failed chunk');
    if(rest){assert.match(sql,/IS NOT NULL/);assert.match(sql,/!= ''/);assert.match(sql,/!= 'ZZ'/);}
    const rows=datesBetween(start,end).map((day,i)=>({day,...(local?{session_country_code:'GB'}:{}),sessions:zero?0:local?(i%2?900:100):rest?1000:2000+unknown,sessions_that_completed_checkout:zero?0:local?(i%2?9:10):rest?29:48}));
    const names=['day',...(local?['session_country_code']:[]),'sessions','sessions_that_completed_checkout'];
    return {shopifyqlQuery:{parseErrors:[],tableData:{columns:names.map(name=>({name})),rows}}};
  };
  const provider=createCountryConversionReportReader({graphql,now:()=>new Date(NOW)});
  return {calls,provider,baseline:createBaselineOverviewService({populationConversion:provider,now:()=>new Date(NOW)})};
}
const conversation=['Compare UK visitor conversion with global visitor conversion for 2026.','Can we see a monthly report of UK vs rest of the world conversion rates for the last 3 years?','Okay for the last 366 days then.','Can I see a monthly breakdown of this?'];
test('complete production conversation executes native non-UK monthly counts and preserves date-only scope',async()=>{
  const f=fixture();let prior=null;
  for(const [i,message] of conversation.entries()){
    const result=await executeGovernedAgentAnalysis({message,analysisContext:prior,baselineOverview:f.baseline,now:NOW});prior=result.analysis_context;
    assert.equal(prior.requested_subject,'population_conversion');
    if(i){assert.equal(prior.grain,'month');assert.deepEqual(prior.population_scope.groups,['country','rest_of_world']);assert.ok(result.evidence.sections.every(s=>s.month));assert.match(result.answer,/Non-UK sessions/);assert.match(result.answer,/2\.90%/);assert.ok(f.calls.some(c=>c.variables?.query?.includes("session_country_code != 'GB'")));}
    assert.equal(answerCompleteness(prior,result).status,'partial');
  }
  const totals=context('Totals instead',prior);assert.equal(totals.grain,null);assert.deepEqual(totals.population_scope,prior.population_scope);
  const month=context('By month',totals);assert.equal(month.grain,'month');
  const global=context('Global instead',month);assert.deepEqual(global.population_scope.groups,['country','global']);assert.equal(global.grain,'month');
  assert.deepEqual(context('Global only',global).population_scope.groups,['global']);
});
test('unfamiliar wording and oversized scope retain independent grouping, membership and dates',()=>{
  for(const q of ['Compare Britain visitor conversion versus the rest of the world by calendar month for the past 3 years','Monthly conversion UK vs rest of world for the last 8 years']){
    const c=context(q);assert.equal(c.grain,'month');assert.deepEqual(c.population_scope.groups,['country','rest_of_world']);
    if(q.includes('8 years'))assert.equal(resolveAnalysisDecision(c).outcome,'limitation');
    const fixed=context('Last 366 days',c);assert.equal(fixed.grain,'month');assert.deepEqual(fixed.population_scope,c.population_scope);assert.equal(resolveAnalysisDecision(fixed).outcome,'execution');
  }
});
test('285/289 and 327/366 reconcile every requested date without historical zeros',async()=>{
  const f=fixture();
  for(const [q,expected] of [['UK vs rest of world conversion for 2026',[289,285,0]],['UK vs rest of world conversion last 366 days',[366,327,35]]]){
    const c=context(q),r=await answerPopulationConversion({context:c,provider:f.provider}),coverage=r.evidence.source.coverage;
    assert.deepEqual([coverage.requested_days,coverage.compatible_report_days,coverage.excluded_days.filter(d=>d.reason==='before_governed_Shopify_launch').length],expected);
    assert.equal(coverage.missing_days.length+coverage.excluded_days.length+coverage.compatible_report_days,coverage.requested_days);
    assert.equal(coverage.excluded_days.filter(d=>d.reason==='documented_measurement_rollout_shop_date_unverified').length,3);
    assert.ok(coverage.excluded_days.some(d=>d.date==='2026-10-16'&&d.reason==='current_or_future_day'));
    assert.equal(coverage.last_compatible_day,'2026-10-15');assert.equal(coverage.upstream_tracking_completeness,'unverified');
  }
});
test('monthly weighted rates, partial months and measurement-era boundaries validate actual rows',async()=>{
  const f=fixture(),c=context('UK vs rest of world monthly visitor conversion 2026-08-15 to 2026-10-12');
  const r=await answerPopulationConversion({context:c,provider:f.provider});
  assert.equal(r.evidence.sections.length,4);assert.equal(r.evidence.sections[0].partial_month,true);
  assert.equal(r.evidence.sections.filter(s=>s.month==='2026-09').length,2);
  for(const s of r.evidence.sections){for(const row of s.rows)assert.equal(row.rate,row.numerator/row.sessions);}
  assert.notEqual(r.evidence.sections[0].rows[0].rate,(.1+.01)/2);
  const monthly=structuredClone(r.evidence);monthly.sections[0].rows[1].sessions+=50;assert.throws(()=>assertPopulationConversionEvidence(c,monthly));
  const totals=await answerPopulationConversion({context:{...c,grain:null},provider:f.provider});
  totals.evidence.analytical_plan=r.evidence.analytical_plan;assert.equal(answerCompleteness(c,totals).status,'incomplete');
  const wrong={...c,population_scope:{...c.population_scope,groups:['country','global']}};assert.throws(()=>assertPopulationConversionEvidence(wrong,r.evidence));
  const charted=withOracleCharts(r),charts=charted.charts;assert.ok(charts.length);
  const badChart=structuredClone(charted.evidence);badChart.chart_specs[0].series[0].value+=1;assert.throws(()=>assertPopulationConversionEvidence(c,badChart));
  for(const chart of charts)for(const p of chart.series){const s=r.evidence.sections.find(s=>s.period.start_date===p.period);const row=s.rows.find(r=>(r.group==='country'?'GB':r.group)===p.label);assert.equal(p.value,row.rate*100);}
});
test('unknown geography stays outside non-UK; zero denominators remain unavailable',async()=>{
  for(const zero of [false,true]){
    const f=fixture({zero}),c=context('UK vs rest of world monthly conversion last month'),r=await answerPopulationConversion({context:c,provider:f.provider});
    if(zero){assert.ok(r.evidence.sections.every(s=>s.rows.every(r=>r.rate===null)));assert.match(r.answer,/Unavailable/);}
    else assert.equal(r.evidence.sections.reduce((n,s)=>n+s.rows[1].sessions,0),27000);
  }
});
test('bounded history checkpoints partial results, failed chunks, cancellation and lease guards',async()=>{
  const f=fixture({failReport:start=>start>'2026-01-01'}),c=context('UK vs rest of world monthly conversion 2025-01-01 to 2026-10-15'),checkpoints=[];
  const r=await answerPopulationConversion({context:c,provider:f.provider,onEvidence:r=>checkpoints.push(structuredClone(r))});
  assert.ok(checkpoints.length>=1);assert.equal(r.partial,true);assert.ok(r.evidence.source.coverage.categories.some(d=>d.reason==='chunk_failed'));assert.ok(r.evidence.sections.length);
  assert.ok(f.calls.length<=20);const windows=countryReportWindows({...c});assert.equal(windows[0].end_date<'2026-01-02',true);assert.equal(windows[1].start_date>'2025-12-31',true);
  await assert.rejects(answerPopulationConversion({context:c,provider:f.provider,assertLease:()=>{throw Object.assign(Error('stale'),{code:'LEASE_NOT_OWNED'});}}),{code:'LEASE_NOT_OWNED'});
  const controller=new AbortController();controller.abort();const before=f.calls.length;
  const cancelled=await f.provider({start_date:c.start_date,end_date:c.end_date,population_scope:c.population_scope,channel:'online',dimensions:[]},{signal:controller.signal});assert.equal(f.calls.length,before);assert.equal(cancelled.supported,false);
});
test('workbook, recovered evidence and tables share validated counts and coverage',async()=>{
  const f=fixture(),c=context('UK vs rest of world monthly conversion last month');c.output_preference='xlsx';let saved;
  const r=await answerPopulationConversion({context:c,provider:f.provider,exportOwner:'owner',requestId:'monthly-country',exportStore:{put:async(id,owner,value)=>{saved=value;}}});
  assert.ok(r.artifact);assert.equal(await assertCountryWorkbook(saved),true);
  saved.envelope.sections[0].rows[1].numerator++;await assert.rejects(assertCountryWorkbook(saved),{code:'EVIDENCE_SCOPE_MISMATCH'});
});

import { acceptanceServer } from './helpers/oracle-acceptance.js';
import { createMemoryExportStore } from '../oracle/product-priority-storage.js';
import ExcelJS from 'exceljs';
for(const durable of [false,true])test(`monthly XLSX owned download and refresh through ${durable?'durable':'interactive'} delivery`,async t=>{
  const f=fixture();f.exportStore=createMemoryExportStore();f.baseline=createBaselineOverviewService({populationConversion:f.provider,socialExportStore:f.exportStore,now:()=>new Date(NOW)});
  const h=await acceptanceServer(f,{durable,now:NOW});t.after(h.close);
  const result=await h.submit('Monthly UK visitor conversion versus rest of world last month. Export XLSX.');assert.ok(result.artifact);
  const downloaded=await fetch(h.origin+result.artifact.download_url,{headers:h.headers});assert.equal(downloaded.status,200);
  const wb=new ExcelJS.Workbook();await wb.xlsx.load(Buffer.from(await downloaded.arrayBuffer()));assert.equal(wb.getWorksheet('Conversion').rowCount,5);assert.equal(wb.getWorksheet('Coverage').rowCount,31);
  assert.equal((await fetch(h.origin+result.artifact.download_url)).status,401);
  const count=f.calls.length;
  if(durable){const recovered=await h.get('/jobs/'+result.job_id);assert.deepEqual(recovered.evidence,result.evidence);assert.equal(recovered.artifact.id,result.artifact.id);}
  const manifest=await fetch(h.origin+result.artifact.download_url+'/manifest',{headers:h.headers});assert.equal(manifest.status,200);assert.equal(f.calls.length,count);
});
test('population refinements preserve filters, grouping and channel until explicitly changed',()=>{
  const prior=context('Monthly UK visitor conversion versus rest of world last month.');prior.dimensions=['device'];prior.channel='instore';prior.filters=['human_sessions'];
  const next=context('Global instead',prior);assert.equal(next.grain,'month');assert.deepEqual(next.dimensions,prior.dimensions);assert.deepEqual(next.filters,prior.filters);assert.equal(next.channel,'instore');assert.equal(resolveAnalysisDecision(next).outcome,'limitation');
});
test('shared grouping refinements across governed subjects change only grain',()=>{
  for(const q of ['Show online sales last month','Show product sales last month','Show monthly mobile and desktop conversion last month','Show Klaviyo campaigns last month','Monthly UK visitor conversion versus global last month']){
    const prior=context(q);assert.ok(prior.tool_route,q);
    const month=context('Per calendar month please',prior);assert.equal(month.grain,'month');assert.deepEqual({...month,grain:prior.grain},prior);
    const totals=context('Whole period instead',month);assert.equal(totals.grain,null);assert.deepEqual({...totals,grain:month.grain},month);
  }
  const daily=context('Daily UK visitor conversion versus rest of world last month');assert.equal(daily.grain,'day');assert.equal(resolveAnalysisDecision(daily).outcome,'limitation');
});
