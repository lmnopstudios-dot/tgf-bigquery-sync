import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {entryAgeTraceCtes,entryAgeTraceSql,entryAgeTraceSettings,ageTraceCollectionIds,ageTraceStages} from '../diagnostics/retention-entry-age-trace.js';
import {customerJourneySql} from '../oracle/customer-journey.js';
import {cohortRelations} from '../oracle/cohort-execution.js';
import {retentionRows} from '../oracle/cohort-retention.js';
const identity={dataset:'customer_identity',snapshot:'history-20261022-billing-v3',orderLinks:true};
const names=[['Motörhead','mot_rhead'],['Iron Maiden','iron_maiden']];
const params={coverage_start:null,coverage_end:null,coverage_status:'unverified',coverage_evidence:null,observation_end:'2026-10-19',cohort_entry_start:'2022-10-19',cohort_entry_end:'2026-10-19',entry_source:null,entry_channel:null};
function adapt(sql){return sql.replace(/DATE\(([^,()]+),@time_zone\)/g,'LD($1)').replaceAll('DATE_ADD(LD(em.entry_timestamp),INTERVAL window_days DAY)',"date(LD(em.entry_timestamp),'+'||window_days||' days')").replaceAll('LEAST(@observation_end,@coverage_end)','MIN(@observation_end,@coverage_end)').replaceAll('DATE_DIFF(LD(d.order_timestamp),LD(em.entry_timestamp),DAY)','(julianday(LD(d.order_timestamp))-julianday(LD(em.entry_timestamp)))').replaceAll('TIMESTAMP_DIFF(d.order_timestamp,em.entry_timestamp,SECOND)/86400.0','(julianday(d.order_timestamp)-julianday(em.entry_timestamp))').replaceAll('em.collaboration_name NOT IN UNNEST(sc.names)','em.collaboration_name NOT IN (SELECT value FROM json_each(sc.names))').replaceAll('em.collaboration_name IN UNNEST(sc.names)','em.collaboration_name IN (SELECT value FROM json_each(sc.names))').replaceAll('CROSS JOIN UNNEST([90,180,360]) window_days','CROSS JOIN (SELECT 90 window_days UNION ALL SELECT 180 UNION ALL SELECT 360)').replaceAll('PERCENTILE_CONT(IF(mature,days_to_second,NULL),0.5)','median(IF(mature,days_to_second,NULL))').replaceAll('COUNTIF(','SUM(').replaceAll('ANY_VALUE(','MIN(');}
function run(sql,extra={}){const p={sql:adapt(sql),params,members:[],returns:[],classes:[],...extra};const r=spawnSync('python3',['test/helpers/retention-sqlite.py'],{input:JSON.stringify(p),encoding:'utf8',timeout:10000});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);}
for(const [label,name]of names){
 test(`${label}: actual generated SQL preserves observed returns with no 360-day denominator and admits old Woo entries`,()=>{
  const all=cohortRelations(customerJourneySql('fixture','retention_windows',null,null,identity)).relations;
  const sql='WITH '+all.filter(r=>['retention_members','retention_with_medians','retention_totals'].includes(r.name)).map(r=>`${r.name} AS (${r.body})`).join(',')+' SELECT * FROM retention_totals';
  const member=date=>['linked','woo','ww',name,date,'woo:ww:1',label];
  const returns=[['linked','2026-06-15T12:00:00Z','shop-return','shopify','shopify']];
  let rows=retentionRows(run(sql,{members:[member('2026-06-01T12:00:00Z')],returns}));
  let r=rows.find(r=>r.window_days===360);assert.deepEqual([r.observed_repeat_customers,r.provisional_eligible_customers,r.provisional_repeat_customers,r.provisional_repeat_rate],[1,0,0,null]);
  rows=retentionRows(run(sql,{members:[member('2025-10-24T12:00:00Z'),member('2025-10-24T12:00:00Z')],returns}));r=rows.find(r=>r.window_days===360);
  assert.deepEqual([r.cohort_customers,r.observed_repeat_customers,r.provisional_eligible_customers,r.provisional_repeat_customers,r.provisional_repeat_rate,r.mature_customers],[1,1,1,1,1,0]);
  r=retentionRows(run(sql,{members:[member('2025-10-24T23:30:00Z')],returns})).find(r=>r.window_days===360);assert.equal(r.provisional_eligible_customers,0,'London Oct 25 is too young; range existence cannot change entry age');
 });
 test(`${label}: actual linked sequencing selects old Woo entry before source/date filters, not the later collaboration purchase`,()=>{
  const all=cohortRelations(customerJourneySql('fixture','retention_windows',null,null,identity)).relations;
  const literals="qualifying_orders AS (SELECT 'linked' governed_customer_ref,'woo' source_platform,'ww' source_store,'old' order_ref,'2024-01-01T12:00:00Z' order_timestamp,'Online' channel UNION ALL SELECT 'linked','shopify','shopify','later','2026-01-01T12:00:00Z','In-store')";
  const sql='WITH '+literals+','+all.filter(r=>['ranked_orders','entry_orders'].includes(r.name)).map(r=>`${r.name} AS (${r.body})`).join(',')+' SELECT * FROM entry_orders';
  assert.equal(run(sql)[0].order_ref,'old');assert.equal(run(sql,{params:{...params,entry_source:'shopify'}}).length,0);
  assert.equal(run(sql.replace('2024-01-01','2021-01-01')).length,0,'entry before scope stays outside; later collaboration purchase is not reassigned as first');
 });
}
test('trace executes the production membership/identity/filter CTEs and caches reused inputs without changing report SQL',()=>{
 const all=cohortRelations(customerJourneySql('fixture','retention_windows',null,null,identity)).relations,q=entryAgeTraceSql('fixture'),trace=cohortRelations(q).relations;
 for(const name of ['raw_orders','orders','qualifying_orders','cr_routes','cr_resolved','ranked_orders','entry_orders','entry_matches','retention_members'])assert.equal(trace.find(r=>r.name===name).body,all.find(r=>r.name===name).body);
 const settings=entryAgeTraceSettings('fixture');assert.equal(settings.jobTimeoutMs,50000);assert.equal(settings.maximumBytesBilled,'6000000000');assert.equal((settings.query.match(/CREATE TEMP TABLE/g)||[]).length,11);assert.match(settings.query,/Identity snapshot integrity failed/);assert.match(settings.query,/history-20261022-billing-v3/);
 assert.deepEqual(settings.params.trace_collection_ids,ageTraceCollectionIds);assert.equal(ageTraceCollectionIds.length,2);assert.ok(ageTraceStages.includes('observed_repeat_360'));assert.ok(ageTraceStages.includes('age_qualified_repeat_360'));assert.ok(ageTraceStages.includes('eligible_sku_candidates_not_governed'));
 assert.match(q,/LEFT JOIN ranked_orders q USING/);assert.match(q,/first_order_named_consumed/);assert.doesNotMatch(entryAgeTraceCtes(),/LIKE.*title|LOWER\(.*title/);
 const variables=[...new Set([...settings.query.matchAll(/@([a-z_]+)/g)].map(m=>m[1]))];assert.deepEqual(variables.filter(v=>!Object.hasOwn(settings.params,v)),[]);
});
const literal=v=>v==null?'NULL':typeof v==='number'?String(v):"'"+v.replaceAll("'","''")+"'";
test('actual trace event SQL separates candidate-only history, source eligibility exclusions and prior-other-entry losses',()=>{
 const body=cohortRelations('WITH '+entryAgeTraceCtes()+' SELECT * FROM trace_events').relations.find(r=>r.name==='trace_events').body;
 const keys=['collection_id','order_timestamp','first_entry_timestamp','candidate_only','named_consumed','governed_customer_ref','migrated','cancelled','status','source_platform','source_store','order_total','refunds','identity_resolution','order_sequence','first_order_named_consumed'];
 const row=(extra={})=>({collection_id:'657969971527',order_timestamp:'2026-01-01T12:00:00Z',first_entry_timestamp:'2024-01-01T12:00:00Z',candidate_only:0,named_consumed:1,governed_customer_ref:'fixture',migrated:0,cancelled:0,status:'paid',source_platform:'shopify',source_store:'shopify',order_total:10,refunds:0,identity_resolution:'matched',order_sequence:2,first_order_named_consumed:0,...extra});
 const cases=[row(),row({collection_id:'658016338247',candidate_only:1,named_consumed:0}),row({governed_customer_ref:null,migrated:1}),row({governed_customer_ref:null,cancelled:1}),row({governed_customer_ref:null,refunds:10}),row({governed_customer_ref:null,status:'pending'})];
 const input=cases.map((r,i)=>'SELECT '+keys.map(k=>literal(r[k])+' '+k).join(',')+`,${i} example`).join(' UNION ALL ');
 let sql='WITH trace_history AS ('+input+'),trace_events AS ('+body+') SELECT example,stage FROM trace_events';
 sql=sql.replace('SELECT h.*,stage FROM','SELECT h.*,stage.value stage FROM').replace('CROSS JOIN UNNEST([','CROSS JOIN json_each(json_array(').replace(']) stage WHERE stage IS NOT NULL',')) stage WHERE stage.value IS NOT NULL');
 const rows=run(sql),stages=i=>rows.filter(r=>r.example===i).map(r=>r.stage);
 assert.ok(stages(0).includes('earlier_entry_other_order'));assert.ok(stages(0).includes('eligible_named_purchases'));
 assert.deepEqual(stages(1).sort(),['eligible_sku_candidates_not_governed','sku_candidate_history_not_governed']);assert.ok(stages(2).includes('excluded_import'));assert.ok(stages(3).includes('excluded_cancelled'));assert.ok(stages(4).includes('excluded_total_or_refund'));assert.ok(stages(5).includes('excluded_status'));
});

test('confirmed BigQuery EXISTS-in-join rejection: prefilter names with distinct governed groups and preserve missing targets',()=>{
 const relations=cohortRelations('WITH '+entryAgeTraceCtes()+' SELECT * FROM trace_targets').relations;
 const selection=relations.slice(0,relations.findIndex(r=>r.name==='trace_targets')+1).map(r=>`${r.name} AS (${r.body})`).join(',');
 assert.doesNotMatch(selection,/\bON\b[^;]*\bEXISTS\s*\(/i,'EXISTS subquery is not supported inside join predicate');
 const ids=ageTraceCollectionIds,records=[
 [ids[0],'collaboration_name','mot_rhead','active','Motörhead'],
 [ids[0],'collection_group','collaboration','active',null],
 [ids[0],'collection_group','collaboration','active',null],
 [ids[1],'collaboration_name','iron_maiden','active','Iron Maiden']
 ];
 const columns=['collection_id','classification_type','classification_value','status','collection_title'];
 const source=rs=>'cr_collection_current AS ('+rs.map(r=>'SELECT '+r.map((v,i)=>literal(v)+' '+columns[i]).join(',')).join(' UNION ALL ')+')';
 const subjects='(SELECT '+literal(ids[0])+' id UNION ALL SELECT '+literal(ids[1])+' id)';
 const original=`SELECT id collection_id,c.classification_value collaboration_name,c.collection_title display_name FROM ${subjects} LEFT JOIN cr_collection_current c ON c.collection_id=id AND c.classification_type='collaboration_name' AND c.status='active' AND EXISTS(SELECT 1 FROM cr_collection_current g WHERE g.collection_id=id AND g.classification_type='collection_group' AND g.classification_value='collaboration' AND g.status='active') ORDER BY collection_id`;
 for(const rs of [records,[...records,[ids[1],'collection_group','collaboration','active',null]],[...records,[ids[1],'collection_group','collaboration','inactive',null]]]){
  const expected=run('WITH '+source(rs)+' '+original);
  const actual=run('WITH '+source(rs)+','+selection.replace('UNNEST(@trace_collection_ids) id',subjects)+' SELECT * FROM trace_targets ORDER BY collection_id');
  assert.deepEqual(actual,expected);assert.equal(actual.length,2,'duplicate group evidence must not multiply membership; missing names/groups retain a null target');
 }
});

test('mapping discovery pages beyond the prior 21-row bound and selects only exact SQL, without queries',async()=>{
 const {readRetainedMappingErrors}=await import('../diagnostics/retention-mapping-job-errors.js');
 const calls=[],events=[],match={id:'mapping-execution',metadata:{jobReference:{location:'US'},configuration:{query:{query:'reviewed mapping'}},statistics:{creationTime:'1000001'}},getMetadata:async()=>[{status:{state:'DONE',errorResult:{reason:'invalidQuery',message:'actual mapping failure distinct from trace'}}}]};
 const bq={job:()=>({getMetadata:async()=>[{statistics:{creationTime:'1000000'}}]}),getJobs:async options=>{calls.push(options);return options.pageToken?[[match],null,{}]:[Array.from({length:25},(_,i)=>({id:'unrelated-'+i,metadata:{configuration:{query:{query:'other SQL'}}}})),{pageToken:'second'},{nextPageToken:'second'}];}};
 const r=await readRetainedMappingErrors({bigquery:bq,mappingSql:'reviewed mapping',onCheck:e=>events.push(e)});
 assert.equal(calls.length,2);assert.equal(calls[1].pageToken,'second');assert.equal(r.inventory_truncated,false);assert.equal(r.status,'read_completed');assert.equal(r.errors[0].error_result.message,'actual mapping failure distinct from trace');assert.equal(r.queries_submitted,0);assert.ok(events.find(e=>e.check==='mapping_inventory_page'&&e.inventory_truncated));
 // Keep an independently discovered match even if the next inventory page fails.
 calls.length=0;bq.getJobs=async options=>{calls.push(options);if(options.pageToken)throw Error('later page unavailable');return [[match],{pageToken:'second'},{}];};
 const partial=await readRetainedMappingErrors({bigquery:bq,mappingSql:'reviewed mapping'});assert.equal(partial.inventory_truncated,true);assert.equal(partial.errors[0].status,'read_completed');assert.equal(partial.status,'unresolved');
});
