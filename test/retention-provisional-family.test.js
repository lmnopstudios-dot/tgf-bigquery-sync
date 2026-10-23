import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {retentionFamilyCtes} from '../oracle/retention-families.js';
import {customerJourneySql} from '../oracle/customer-journey.js';
import {cohortRelations} from '../oracle/cohort-execution.js';
import {retentionRows,retentionMarkdown} from '../oracle/cohort-retention.js';
import {provisionalEvidence} from '../oracle/retention-provisional.js';
const identity={dataset:'customer_identity',snapshot:'history-20261022-billing-v3',orderLinks:true};
function translate(sql){return sql.replaceAll('DATE(e.order_timestamp,@time_zone)','LD(e.order_timestamp)').replaceAll('EXTRACT(YEAR FROM LD(e.order_timestamp))',"CAST(substr(LD(e.order_timestamp),1,4) AS INTEGER)")
 .replaceAll('DATE(e.entry_timestamp,@time_zone)','LD(e.entry_timestamp)').replaceAll('DATE(d.order_timestamp,@time_zone)','LD(d.order_timestamp)')
 .replaceAll('DATE_ADD(LD(e.entry_timestamp),INTERVAL window_days DAY)',"date(LD(e.entry_timestamp),'+'||window_days||' days')").replaceAll('LEAST(@observation_end,@coverage_end)','MIN(@observation_end,@coverage_end)')
 .replaceAll('DATE_DIFF(LD(d.order_timestamp),LD(e.entry_timestamp),DAY)','(julianday(LD(d.order_timestamp))-julianday(LD(e.entry_timestamp)))').replaceAll('TIMESTAMP_DIFF(d.order_timestamp,e.entry_timestamp,SECOND)/86400.0','(julianday(d.order_timestamp)-julianday(e.entry_timestamp))')
 .replaceAll('CROSS JOIN UNNEST([90,180,360]) window_days','CROSS JOIN (SELECT 90 window_days UNION ALL SELECT 180 UNION ALL SELECT 360)').replaceAll('PERCENTILE_CONT(IF(mature,days_to_second,NULL),0.5)','median(IF(mature,days_to_second,NULL))')
 .replaceAll('COUNTIF(','SUM(').replaceAll('ANY_VALUE(','MIN(').replaceAll('UNION DISTINCT','UNION').replaceAll("r'", "'");}
function execute(sql,extra={}){const p={sql:translate(sql),params:{coverage_start:null,coverage_end:null,observation_end:'2026-10-19',coverage_status:'unverified',coverage_evidence:null},entries:[],lines:[],returns:[],...extra};const r=spawnSync('python3',['test/helpers/retention-sections-sqlite.py'],{input:JSON.stringify(p),encoding:'utf8'});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);}
const governed={routes:[['woo:ww:1','shopify:shopify:10','approved_reporting_family'],['woo:ww:2','shopify:shopify:10','approved_reporting_family'],['woo:ww:3','shopify:shopify:10','approved_reporting_family'],['woo:ww:3','shopify:shopify:20','approved_reporting_family'],['woo:ww:4','shopify:shopify:10','approved_identity']],families:[['woo:ww:1','shopify:shopify:10'],['woo:ww:2','shopify:shopify:10']],labels:[['shopify:shopify:10','Reviewed family','active']]};
test('actual governed family SQL keeps ambiguity/unmapped items and never infers families from similar titles',()=>{
 const rows=execute('WITH '+retentionFamilyCtes()+' SELECT source_product_ref,reporting_product_ref,reporting_product_title,family_status FROM retention_reporting_lines ORDER BY source_product_ref',{governed,lines:[1,2,3,4,5].map(id=>['woo','ww','entry','woo:ww:'+id,'Same title - size '+id,String(id)])});
 assert.deepEqual(rows.map(r=>[r.reporting_product_ref,r.family_status]),[['family:shopify:shopify:10','governed_family'],['family:shopify:shopify:10','governed_family'],['woo:ww:3','ambiguous_family'],['woo:ww:4','unmapped_item'],['woo:ww:5','unmapped_item']]);assert.equal(rows[0].reporting_product_title,'Reviewed family');
});
for(const baseline of [false,true])test(`execute actual age-qualified provisional aggregation; deduplicate family members; baseline=${baseline}`,()=>{
 const {relations}=cohortRelations(customerJourneySql('fixture',baseline?'retention_baseline_windows':'retention_piece_windows','woo','ww',identity));
 const sql='WITH '+retentionFamilyCtes()+', '+relations.filter(r=>['section_entries','section_members','section_medians','section_totals'].includes(r.name)).map(r=>`${r.name} AS (${r.body})`).join(',')+' SELECT * FROM section_totals';
 const rows=execute(sql,{governed,entries:[['a','woo','ww','a','2025-10-20T12:00:00Z'],['b','woo','ww','b','2026-08-01T12:00:00Z'],['c','woo','ww','c','2025-01-01T12:00:00Z']],lines:[['woo','ww','a','woo:ww:1','Size 1','1'],['woo','ww','a','woo:ww:2','Size 2','2'],['woo','ww','b','woo:ww:1','Size 1','1'],['woo','ww','c','woo:ww:2','Size 2','2']],returns:[['a','2025-11-03T12:00:00Z'],['b','2026-08-06T12:00:00Z'],['c','2025-07-20T12:00:00Z']]});
 if(baseline){const totals=[90,180,360].map(window_days=>{const part=rows.filter(r=>r.window_days===window_days);const keys=['cohort_customers','observed_repeat_customers','provisional_eligible_customers','provisional_repeat_customers','mature_customers'];const sum=Object.fromEntries(keys.map(k=>[k,part.reduce((n,r)=>n+r[k],0)]));return {...sum,window_days,provisional_repeat_rate:sum.provisional_repeat_customers/sum.provisional_eligible_customers};});rows.splice(0,rows.length,...totals);}
 assert.equal(rows.length,3);rows.sort((a,b)=>a.window_days-b.window_days);
 assert.deepEqual(rows.map(r=>[r.cohort_customers,r.observed_repeat_customers,r.provisional_eligible_customers,r.provisional_repeat_customers,r.provisional_repeat_rate,r.mature_customers]),[[3,2,2,1,0.5,0],[3,2,2,1,0.5,0],[3,3,2,2,1,0]]);
 if(!baseline)assert.ok(rows.every(r=>r.entry_product_ref==='family:shopify:shopify:10'&&r.entry_family_status==='governed_family'));
});
for(const window of [90,180,360])test(`London calendar-day boundary includes exactly ${window} days and excludes a recent returner`,()=>{
 const {relations}=cohortRelations(customerJourneySql('fixture','retention_baseline_windows','woo','ww',identity));const sql='WITH '+relations.filter(r=>['section_entries','section_members','section_medians','section_totals'].includes(r.name)).map(r=>`${r.name} AS (${r.body})`).join(',')+' SELECT * FROM section_totals';
 const boundary=Date.parse('2026-10-19T00:00:00Z')-window*86400000,exact=new Date(boundary-1800000).toISOString(),recent=new Date(boundary+23.5*3600000).toISOString();
 const rows=execute(sql,{entries:[['exact','woo','ww','1',exact],['recent','woo','ww','2',recent]],returns:[['exact','2026-10-19T12:00:00Z'],['recent',new Date(boundary+3*86400000).toISOString()]]});const r=rows.find(r=>r.window_days===window);assert.equal(r.provisional_eligible_customers,1);assert.equal(r.provisional_repeat_customers,1);assert.equal(r.observed_repeat_customers,2);
});
test('provisional contract rejects fabricated rates/totals and preserves retained evidence without a new denominator',()=>{
 const r={cohort_customers:10,observed_repeat_customers:4,mature_customers:0,repeat_customers:0,provisional_eligible_customers:5,provisional_repeat_customers:2,provisional_repeat_rate:0.4};assert.equal(provisionalEvidence(r).provisional_repeat_rate,0.4);for(const bad of [{provisional_repeat_rate:4/5},{provisional_repeat_customers:6},{provisional_eligible_customers:11},{mature_customers:6},{provisional_repeat_rate:''}])assert.throws(()=>provisionalEvidence({...r,...bad}));assert.deepEqual(provisionalEvidence({cohort_customers:10,observed_repeat_customers:4}),{});assert.equal(provisionalEvidence({...r,provisional_eligible_customers:0,provisional_repeat_customers:0,provisional_repeat_rate:null}).provisional_repeat_rate,null);
});
test('all nine linked query shapes share calendar-age eligibility and preserve coverage and identity guards',()=>{
 for(const [source,store] of [['woo','ww'],['woo','usd'],['shopify','shopify']])for(const group of ['retention_windows','retention_piece_windows','retention_baseline_windows']){const q=customerJourneySql('fixture',group,source,store,identity);assert.match(q,/DATE_ADD\(DATE\(em.entry_timestamp,@time_zone\),INTERVAL window_days DAY\)<=@observation_end/);assert.match(q,/COUNTIF\(provisional_eligible AND days_to_second IS NOT NULL\) provisional_repeat_customers/);assert.match(q,/COUNTIF\(mature AND days_to_second IS NOT NULL\) repeat_customers/);assert.match(q,/Identity snapshot integrity failed/);assert.match(q,/NOT migrated/);if(group!=='retention_windows')assert.match(q,/DATE_ADD\(DATE\(e.entry_timestamp,@time_zone\),INTERVAL window_days DAY\)<=@observation_end/);}
});

test('concise report leads with comparisons and keeps full verified results/caveats accessible without nested details',()=>{
 const triple=(name,extra={})=>[90,180,360].map(window_days=>({source_platform:'woo',source_store:'ww',collaboration_name:name,window_days,cohort_customers:10,observed_repeat_customers:4,mature_customers:0,repeat_customers:0,median_days_to_second:null,observation_coverage_status:'unverified',second_order_products:[{product_ref:'family:shopify:shopify:10',product:'Reviewed family',observed_customers:2,mature_repeat_customers:0}],second_order_product_coverage:{missing_line_customers:1,unidentified_product_customers:1,untitled_product_customers:0},provisional_eligible_customers:5,provisional_repeat_customers:2,provisional_repeat_rate:0.4,...extra}));
 const e={periods:[{start_date:'2022-10-19',end_date:'2026-10-19'}],rows:[...triple('alpha'),...triple('alpha',{entry_product_ref:'family:shopify:shopify:10',entry_product:'Reviewed family',entry_family_status:'governed_family'})],baseline_rows:triple('Sitewide'),product_ranking_rows:triple(null,{entry_product_ref:'family:shopify:shopify:10',entry_product:'Reviewed family',entry_family_status:'governed_family',count_rank:1,rate_rank:null,provisional_rate_rank:1}),definition:{cohort_entry_start:'2022-10-19',cohort_entry_end:'2026-10-19'},observation_end:'2026-10-19',requested_components:{second_products:true},source_outcomes:[{source_platform:'woo',source_store:'usd',group:'retention_windows',state:'rejected',stage:'population_query'}]};
 const text=retentionMarkdown(e),main=text.split('<details>')[0];assert.match(main,/2 \/ 5 \(40.0%\)/);assert.doesNotMatch(main,/4 \/ 10/);assert.match(main,/Verified-coverage rates are separate/);assert.match(main,/uncertain prior history and follow-up, including migration/);assert.match(main,/unknown attribution/);assert.match(main,/unmapped|governed family/);assert.match(main,/population_query/);assert.ok(main.indexOf('Collaboration comparison')<main.indexOf('product rankings'));assert.ok(main.indexOf('product rankings')<main.indexOf('Second-order products'));assert.doesNotMatch(main,/Governed collection reconciliation|First observed in all available/);assert.equal(text.match(/<details>/g).length,1);assert.match(text,/Pieces within/);assert.match(text,/Mature 90-day customers/);assert.match(text,/First observed in all available/);
 const bad=structuredClone(e.rows);bad[0].provisional_repeat_rate=0.8;assert.throws(()=>retentionRows(bad));
});

test('second-order family aggregation counts a customer once across multiple governed size lines',()=>{
 const {relations}=cohortRelations(customerJourneySql('fixture','retention_baseline_windows','woo','ww',identity));const counts=relations.find(r=>r.name==='retention_product_counts');const sql='WITH '+retentionFamilyCtes()+`, retention_product_counts AS (${counts.body}) SELECT * FROM retention_product_counts`;
 const rows=execute(sql,{governed,members:[['woo','ww','Sitewide',90,'customer',0,'woo','ww','return',14],['woo','ww','Sitewide',90,'customer',0,'woo','ww','return',14]],lines:[['woo','ww','return','woo:ww:1','Size 1','1'],['woo','ww','return','woo:ww:2','Size 2','2']]});assert.equal(rows.length,1);assert.equal(rows[0].product_ref,'family:shopify:shopify:10');assert.equal(rows[0].product,'Reviewed family');assert.equal(rows[0].family_status,'governed_family');assert.equal(rows[0].observed_customers,1);
});

 test('already approved Woo identity routes group with the Shopify parent without inventing a reporting family',()=>{
 const rows=execute('WITH '+retentionFamilyCtes()+' SELECT reporting_product_ref,family_status FROM retention_reporting_lines ORDER BY source_product_ref',{governed:{identities:[['woo:ww:4','shopify:shopify:10']]},lines:[['woo','ww','entry','woo:ww:4','Archived Woo product','4'],['shopify','shopify','entry','shopify:shopify:10','Shopify product','10']]});
 assert.deepEqual(rows.map(r=>r.reporting_product_ref),['shopify:shopify:10','shopify:shopify:10']);assert.equal(rows[1].family_status,'governed_product');
 });

import {retentionSectionProjection} from '../oracle/retention-sections.js';
function rankedProjection(sql,extra,projection=retentionSectionProjection(false)){
 // SQLite lacks BigQuery SELECT * REPLACE. Expand its columns while executing
 // the factory's exact replacement expressions and selection/order predicates.
 const raw=execute(sql+' SELECT * FROM section_ranked',extra);
 const replacements=projection.match(/REPLACE\((.*)\) FROM section_ranked/)[1];
 const columns=Object.keys(raw[0]).filter(k=>!['provisional_rate_rank','rate_rank'].includes(k));
 const prefix=projection.split('* REPLACE')[0].replace('ARRAY(SELECT AS STRUCT ','');
 return execute(sql+' SELECT '+prefix+columns.join(',')+','+replacements+' FROM section_ranked'+projection.split(' FROM section_ranked')[1].replace(/\) product_ranking_rows$/,''),extra);
}
test('retained ec078a04 five rejected rows: select by primary rank, preserve empty windows, omit unsupported rate ranks',()=>{
 const cases=[['10434354250055',360,1,458,1],['10434355888455',360,3,462,2],['10541784269127',360,1,488,3],['10685503897927',180,1,494,4],['10685503897927',360,1,494,4]];
 const raw=cases.map(([id,window_days,cohort_customers,count_rank,provisional_rate_rank])=>({population_scope:'linked_tgf',source_platform:'tgf',source_store:'combined',entry_product_ref:'shopify:shopify:'+id,collaboration_name:null,window_days,cohort_customers,mature_customers:0,repeat_customers:0,observed_repeat_customers:1,provisional_eligible_customers:0,provisional_repeat_customers:0,provisional_repeat_rate:null,count_rank,rate_rank:null,provisional_rate_rank,observation_coverage_status:'unverified',median_days_to_second:null}));
 for(const r of raw)assert.throws(()=>retentionRows([r]),/Invalid provisional ranking/);
 const literal=v=>v===null?'NULL':typeof v==='number'?String(v):"'"+v.replaceAll("'","''")+"'";
 const sql='WITH section_ranked AS ('+raw.map(r=>'SELECT '+Object.entries(r).map(([k,v])=>literal(v)+' '+k).join(',')).join(' UNION ALL ')+')';
 const corrected=rankedProjection(sql,{});
 assert.equal(corrected.length,5);assert.deepEqual(corrected.map(r=>r.entry_product_ref),raw.map(r=>r.entry_product_ref));
 for(let i=0;i<raw.length;i++){assert.deepEqual(corrected[i],{...raw[i],provisional_rate_rank:null});}
 assert.equal(retentionRows(corrected).length,5);
});
for(const ranking_window of [90,180,360])test(`generated ranking SQL retains three comparison windows, strict empty denominators; ranking=${ranking_window}`,()=>{
 const {relations}=cohortRelations(customerJourneySql('fixture','retention_piece_windows',null,null,identity,true));
 const sql='WITH '+relations.filter(r=>['section_entries','section_members','section_medians','section_totals','section_scores','section_ranked'].includes(r.name)).map(r=>`${r.name} AS (${r.body})`).join(',');
 const extra={params:{coverage_start:null,coverage_end:null,observation_end:'2026-10-19',coverage_status:'unverified',coverage_evidence:null,ranking_window},entries:[['recent','tgf','combined','a','2026-06-01T12:00:00Z'],['older','tgf','combined','b','2025-01-01T12:00:00Z']],lines:[['tgf','combined','a','shopify:shopify:1','Recent','1'],['tgf','combined','b','shopify:shopify:2','Older','2']],returns:[['recent','2026-06-02T12:00:00Z'],['older','2025-01-02T12:00:00Z']]};
 const rows=rankedProjection(sql,extra);assert.equal(rows.length,6);
 for(const r of rows){if(r.provisional_eligible_customers===0){assert.equal(r.provisional_repeat_rate,null);assert.equal(r.provisional_rate_rank,null);}assert.equal(r.rate_rank,null);}
 assert.equal(retentionRows(rows.map(r=>({...r,population_scope:'linked_tgf'}))).length,6);
});

import {combinedRetentionSql} from '../oracle/retention-population.js';
test('combined item * REPLACE projection carries scope through actual SQL and strict result validation',()=>{
 const projection=combinedRetentionSql(retentionSectionProjection(false),'fixture','retention_piece_windows');
 assert.match(projection,/SELECT AS STRUCT 'linked_tgf' population_scope,\* REPLACE/);
 const q=customerJourneySql('fixture','retention_piece_windows',null,null,identity,true);
 const compact=combinedRetentionSql(retentionSectionProjection(false,true),'fixture','retention_piece_windows');
 assert.ok(q.includes(compact));assert.match(compact,/IF\(r.cohort_rank IS NULL/);
 const sql="WITH section_ranked AS (SELECT 'tgf' source_platform,'combined' source_store,'shopify:shopify:1' entry_product_ref,NULL collaboration_name,90 window_days,1018 cohort_customers,0 mature_customers,0 repeat_customers,262 observed_repeat_customers,1018 provisional_eligible_customers,262 provisional_repeat_customers,262.0/1018 provisional_repeat_rate,1 count_rank,NULL rate_rank,101 provisional_rate_rank,'unverified' observation_coverage_status,NULL median_days_to_second)";
 const unscoped=rankedProjection(sql,{});assert.throws(()=>retentionRows(unscoped),/Missing retention population/);
 const scoped=rankedProjection(sql,{},projection);assert.equal(scoped[0].population_scope,'linked_tgf');assert.equal(retentionRows(scoped).length,1);
 for(const bad of [{...scoped[0],population_scope:undefined},{...scoped[0],source_platform:'woo',source_store:'ww'}])assert.throws(()=>retentionRows([bad]),/Missing retention population/);
 const baseline=combinedRetentionSql(retentionSectionProjection(true),'fixture','retention_baseline_windows');
 assert.match(baseline,/SELECT AS STRUCT 'linked_tgf' population_scope,\* FROM section_totals/);
 assert.ok(customerJourneySql('fixture','retention_baseline_windows',null,null,identity,true).includes(baseline));
 for(const [source,store] of [['woo','ww'],['woo','usd'],['shopify','shopify']])assert.ok(customerJourneySql('fixture','retention_piece_windows',source,store,identity).includes(retentionSectionProjection(false,true)));
});
