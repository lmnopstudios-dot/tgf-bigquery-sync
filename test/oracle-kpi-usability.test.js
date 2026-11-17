import ExcelJS from 'exceljs';
import {createHash} from 'node:crypto';
import {kpiWorkbookTables,assertKpiArtifact} from '../oracle/kpi-dashboard.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {kpiReadiness,kpiBaselineValue,kpiNextStep} from '../public/oracle/kpi-readiness.js';
import {kpiCoverageSummary} from '../oracle/kpi-reader.js';
import {kpiFixture,KPI_NOW} from './helpers/kpi-fixture.js';
import {transitionAnalysisContext} from '../oracle/analysis-context.js';
const context=transitionAnalysisContext(null,'KPI dashboard for October 2026',{now:KPI_NOW}).context;
const readReport=async coverage=>{const f=kpiFixture({...(coverage?{coverage}:{} )});return (await f.service('KPI dashboard for October 2026',{analysisContext:context,now:KPI_NOW,exportOwner:'o',requestId:'usability'})).evidence;};
test('supported cards and pending measures stay separate without promoting unknown customer history',async()=>{
 const e=await readReport(),s=kpiReadiness(e,'GBP');assert.equal(s.selected_available.length,4);assert.equal(s.selected_pending.length,6);assert.equal(s.selected_available.some(r=>r.metric==='new_customers'),false);assert.equal(s.selected_pending.filter(r=>r.metric==='conversion').length,3);
 assert.equal(s.classification.known_share_minimum,.5);assert.equal(s.classification.first,1);assert.equal(s.classification.customerless,1);assert(e.summary.filter(r=>['new_customers','returning_rate'].includes(r.metric)).every(r=>r.value===null));
});
test('production-like 201 known earlier purchasers and 759 first observed remain minimum/unknown classification',()=>{
 const e={summary:[],rows:[{period:'selected',metric:'aov',currency:'GBP',source_reconciled:true,purchasing_customers:960,observed_returning_customers:201,first_observed_customers:759,customerless_orders:289}]};
 const s=kpiReadiness(e,'GBP');assert.equal(s.classification.known,201);assert.equal(s.classification.first,759);assert.equal(s.classification.known_share_minimum,201/960);
 const bad=structuredClone(e);bad.rows[0].source_reconciled=false;assert.equal(kpiReadiness(bad,'GBP').classification,null);bad.rows[0].source_reconciled=true;bad.rows[0].purchasing_customers=1000;assert.equal(kpiReadiness(bad,'GBP').classification,null);
});
test('proposed baseline can be shown for reference without becoming a fixed target or changing stored evidence',async()=>{
 const e=await readReport(),r=e.summary.find(r=>r.metric==='aov'&&r.currency==='GBP'&&r.period==='selected');e.baseline.fixed=false;r.baseline_value=null;
 const before=JSON.stringify(e),display=kpiBaselineValue(e,r);assert.equal(display.value,150);assert.match(display.label,/Proposed/);assert.equal(JSON.stringify(e),before);assert.equal(r.baseline_value,null);
 e.baseline.fixed=true;r.baseline_value=123;assert.equal(kpiBaselineValue(e,r).value,123);assert.match(kpiBaselineValue(e,r).label,/Fixed/);
});
test('coverage ends on 15 November while MTD includes 16 November: supported October remains visible, MTD stays withheld',async()=>{
 const coverage=[{source:'shopify',channel:'all',start_at:'2025-01-01T00:00:00Z',end_exclusive:'2026-11-16T00:00:00Z'}];
 const e=await readReport(coverage),s=kpiReadiness(e,'GBP');assert.equal(e.coverage_summary.latest_reconciled_day,'2026-11-15');assert.equal(e.coverage_summary.gap_calendar_days,1);assert.equal(s.selected_available.length,4);assert.equal(s.mtd_available.length,0);assert(s.mtd_pending.some(r=>/source-reconciled/.test(r.reason||'')));
 assert.match(kpiNextStep(s.mtd_pending.find(r=>r.metric==='aov')),/missing source dates/);
});
test('coverage metadata handles London DST, partial days, combined-channel gaps and no certificates',()=>{
 const now=Date.parse('2026-10-27T12:00:00Z'),interval=[{channel:'all',start_at:'2026-10-24T23:00:00Z',end_exclusive:'2026-10-26T12:00:00Z'}];
 assert.equal(kpiCoverageSummary(interval,'combined',now).latest_reconciled_day,'2026-10-25');assert.equal(kpiCoverageSummary(interval,'combined',now).gap_calendar_days,1);
 assert.equal(kpiCoverageSummary([{...interval[0],channel:'online'}],'combined',now).latest_reconciled_day,null);
 assert.equal(kpiCoverageSummary([],'online',now).gap_calendar_days,null);
});
test('older saved reports remain readable without inventing reconciliation metadata',async()=>{
 const e=await readReport();delete e.coverage_summary;delete e.coverage_ranges;const s=kpiReadiness(e,'GBP');assert.equal(s.selected_available.length,4);assert.equal(s.selected_pending.length,6);
 const w=new ExcelJS.Workbook();for(const [name,rows] of kpiWorkbookTables(e)){const sheet=w.addWorksheet(name),keys=[...new Set(rows.flatMap(Object.keys))];sheet.columns=keys.map(key=>({header:key,key}));sheet.addRows(rows);}
 const bytes=Buffer.from(await w.xlsx.writeBuffer());await assertKpiArtifact({analysis_context:context,envelope:e,xlsx_base64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')});
 for(const r of s.selected_pending)assert.equal(typeof kpiNextStep(r),'string');
});
