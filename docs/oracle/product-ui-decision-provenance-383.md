> Update: the supplied production read passed destination, positive-control and parser checks. The 24 Woo references have no persisted decisions; related Square decisions remain separate. See [Woo review and saved-receipt findings](woo-review-and-source-receipts-383.md). Do not rerun the warehouse command below to inspect receipts already saved locally.

# Product Mapping UI provenance: current finding remains unverified

The successful supplied diagnostic is evidence that **both SELECTs compile and complete**, not that the supplied products lack UI approvals. Candidate job `oracle_ui_routes_da143f25-c64c-4841-8cd1-8706345c59e6` returned only 40 `variation_keys` records; deployed job `oracle_ui_routes_4e9314d8-46bd-4a7a-bbeb-d5915c464031` returned no groups. Both were within bounds. All 24 displayed empty rows were projections of these results, not 24 independent UI history reads.

The earlier generic resolver fixes are **not a demonstrated solution for these products**. Do not use their fixture success as proof of production attribution. No further business resolver change, new approval or report replay is made here.

## Actual UI read/write path in current source

| Step | Actual path / contract |
|---|---|
| Browser read | `public/oracle/app.js` calls same-origin `/api/oracle/product-mappings`, `/decisions` and `/families`. |
| Browser write | The selected historical product's `source_product_ref` and chosen Shopify parent's `source_product_ref` are sent unchanged to `/product-mappings/bulk-review` or the individual review/family actions. |
| Router | `oracle/ui-router.js` binds these actions to the injected `productMappingService`. |
| Runtime binding | `server.js` constructs `createProductMappingService({bigquery,project:GOOGLE_PROJECT_ID})`. Its environment destructuring defaults `GOOGLE_PROJECT_ID` to `gf-full-data`, **not** the credential project. |
| UI product keys | `loadProducts` builds `CONCAT(source_platform,':',source_store,':',source_product_id)` from persisted order-line parent product IDs: e.g. `woo:ww:11737` and `woo:usd:106660`. It does not strip titles or substitute variation IDs. Shopify product references may contain Product GIDs. |
| Identity decisions | UI `decisions()` SELECTs every row of `<UI project>.commerce.product_mapping_decisions`; review actions MERGE to that same captured table. Legacy decision/relationship identifiers are resolved after reading. |
| Reporting families | UI `familyDecisions()` SELECTs every row of `<UI project>.commerce.product_family_decisions`; family actions MERGE to the same captured table. Families remain distinct from canonical identity. |
| Outcomes / operation receipts | `<UI project>.commerce.product_mapping_review_outcomes` and `product_mapping_operations`; these can record an investigation/no-equivalent outcome or submitted/failed operation without an approved relationship. |
| Report | `classificationReaderCtes(project)` reads the configured project's governed decision and classification tables. Only current approved identity/active family routes propagate classifications. |

There is a **potential diagnostic destination mismatch**, not a verified production mismatch: `loadBigQueryConfig` uses `env.GOOGLE_PROJECT_ID || credentials.project_id || 'gf-full-data'`, whereas the UI server defaults directly to `gf-full-data` when the environment variable is absent. The saved file contains the prior diagnostic project; the focused check below compares it with the deployed server's actual source/configuration before querying. No configuration is changed.

There is also a **UI visibility distinction**, not an assertion about what the user clicked: `loadProducts` can mark `mapping_status='resolved'` from unique SKU/title evidence, and `buildHistoricalReviewIndex` excludes those products from the review queue. Disappearing from that queue does not itself prove that an approval was written. These heuristics are not promoted into report governance by this investigation.

## Positive control and result parsing

The previous successful full discovery already contains a concrete persisted UI family decision:

- END. Woo WW `114959` → Shopify Product `10549750563143` (stored as a Product GID).
- Decision `247926596db75119da1e545bee604951`, active in that discovery, reviewed `2026-09-28T10:58:40.829Z`.
- That discovery showed both `approved_reporting_family` routing and consumed named classification. Its current state must be checked; historical active status is not assumed to remain active.

The current reader parses every returned `kind` and JSON record; it does not filter identity/family rows after retrieval. SQL output bounds cover every kind independently, and the completed reads reported no truncation. However, the pasted terminal summary alone cannot prove that the correct UI destination/keys were queried or that saved groups match the actual retained result. The check below reads those two completed jobs' metadata/results (at most 51 rows each), compares group counts and records with the saved file, and never executes their SQL again.

It then reads the **actual UI destination**, independently for all four persisted table types. Operation receipts are read first; their persisted `decision_event_id` values are included in the identity/family lookup, so malformed or different source keys cannot hide a decision linked by an actual saved UI receipt. Inventory counts establish whether each table has data; an intentionally inclusive filter finds the exact product/variation keys already supplied, known Shopify targets, the positive control ID, and explicitly labelled collection-title leads. Title leads locate already-written records for inspection, never establish a new identity. Same-relationship history and superseding decision pointers remain included. The deployed UI pure resolvers evaluate the raw decisions (restoring the same BigQuery timestamp wrappers used by the UI service); no service method with setup side effects is invoked. A separate actual deployed report-reader SELECT checks the positive control and these same stored references through current resolution and classification. No catalogue/order discovery or customer population is queried.

## Interpretation and blocker

**Current finding: still unverified.** The supplied result proves no matching decision records were returned by the previous diagnostic scope. It does not yet distinguish wrong destination, different persisted keys, filtering/parsing issues, genuinely absent exact-key decisions or inactive decisions.

- **Existing decisions located and consumed:** exact persisted UI refs plus an approved current report route and named classification, with the positive control passing.
- **Saved under a different destination:** actual UI destination differs from the saved diagnostic project and the relevant exact-key decisions are found there. Record both fully qualified destinations; do not change either automatically.
- **Different key candidates:** persisted records are found under other source/parent/variation keys. Inspect their actual keys and operation receipts. A current approval on a variation is reported separately when the prior successful result supplies the exact persisted parent/variation key pair. This establishes a different stored key, not approval of every variant or its parent. A persisted UI operation receipt linking a source ref to a specific `decision_event_id` is reported as direct provenance for a different stored key; its current approval and report consumption are still separate checks. Title/target similarity alone does not prove they represent these products and does not authorize transferring an approval.
- **Genuinely absent for exact current UI refs:** complete core table reads and a passing positive control show no history at those exact refs. This is a bounded statement about this UI destination/key contract, not proof that no related mapping exists under another historical key or elsewhere. A saved operation without its decision remains a persistence discrepancy to investigate, not a request to approve again.
- **Still unverified:** control missing/inactive/unconsumed, destination unconfirmed, any necessary read incomplete/truncated, alternate-key ambiguity, or history present but not currently consumed. Preserve the records and reason; never substitute zero customers. Failure or expiry of an old retained-result check does not erase independently located/consumed decisions; it keeps otherwise-empty product findings unverified.

Development Google access remains blocked. Production execution of the following check is essential to move beyond “still unverified”; no live positive-control result is claimed here. The command was syntax-checked and executed with mocked BigQuery transport, including deliberately different UI/diagnostic projects, a known approved family, one consumed product, retained-result equality and prior-file preservation. All four exact raw persistence SELECTs and the actual reader SELECT also executed after SQL dialect translation on synthetic fixtures. Neither that translation nor the mock is production BigQuery evidence. Runtime/report source is unchanged in this follow-up. The required acceptance gate passes 852/852 tests (21 central conversations, 63 regression suites); desktop/mobile browser gates pass. The added command regression separately covers positive control, persisted variation keys, receipt-linked alternate keys, missing control and parser mismatch. These are local/mock checks, not live UI evidence.

## One bounded UI destination and positive-control read

Run from the same deployed `src` directory. This is the only new operative check; do not repeat discovery or the earlier empty-scope query. It backs up `/tmp/oracle-ui-product-routes-383.json`, then saves independent outcomes there. At most five governance SELECTs (four raw table reads capped at 50 MB/6 seconds each; one deployed reader capped at 100 MB/12 seconds), two exact retained result reads and one dataset-location metadata read. Shared client allowance 55 seconds; outer bound 65 seconds. No API methods that call `setup()`, DDL, collection, reapproval, report replay or production business-data writes. Limits on the production report are unchanged. Raw records and SQL stay in the private file; terminal output includes compact per-product findings and up to 21 unattributed persisted decision keys, with explicit display truncation. No follow-up print command is needed.

```sh
timeout --signal=TERM --kill-after=5s 65s node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,statSync,copyFileSync,chmodSync,constants} from 'node:fs';
import {BigQuery} from '@google-cloud/bigquery';
import {loadBigQueryConfig} from './bigquery/client.js';
import {classificationReaderCtes,normalizeClassificationRef} from './oracle/classification-reader.js';
import {PRODUCT_MAPPING_DATASET,PRODUCT_MAPPING_TABLE,PRODUCT_FAMILY_TABLE,PRODUCT_REVIEW_OUTCOME_TABLE,PRODUCT_MAPPING_OPERATION_TABLE,resolveMappingDecisions,resolveFamilyDecisions,relationshipId} from './oracle/product-mapping.js';
const file='/tmp/oracle-ui-product-routes-383.json';
assert.ok(statSync(file).size<=16777216,'Existing evidence exceeds backup bound');
const prior=JSON.parse(readFileSync(file,'utf8'));
const backup=file+'.previous-'+Date.now();copyFileSync(file,backup,constants.COPYFILE_EXCL);chmodSync(backup,0o600);
process.umask(0o077);
const out={read_only:true,report_replayed:false,previous_evidence_file:backup,finding:'still_unverified',checks:[],allocated_queries:[]};
const save=()=>writeFileSync(file,JSON.stringify(out),{mode:0o600});save();
const end=Date.now()+55000;
async function bounded(action,ms){let timer;try{return await Promise.race([action(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Diagnostic deadline')),Math.max(1,Math.min(ms,end-Date.now())));})]);}finally{clearTimeout(timer);}}
const clean=e=>String(e?.message||e).replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[redacted]').slice(0,500);
try{
 const server=readFileSync('./server.js','utf8');
 assert.match(server,/createProductMappingService\(\{\s*bigquery,\s*project:\s*GOOGLE_PROJECT_ID\s*\}\)/);
 const defaultProject=server.match(/\bGOOGLE_PROJECT_ID\s*=\s*['"]([^'"]+)['"]/)[1];
 const uiProject=process.env.GOOGLE_PROJECT_ID===undefined?defaultProject:process.env.GOOGLE_PROJECT_ID;
 const {project:helperProject,credentials}=loadBigQueryConfig();
 for(const p of [uiProject,helperProject,prior.project||helperProject])assert.match(p,/^[A-Za-z0-9_-]+$/);
 const dataset=PRODUCT_MAPPING_DATASET;assert.match(dataset,/^[A-Za-z0-9_]+$/);
 out.destination={ui_project:uiProject,ui_dataset:dataset,helper_project:helperProject,prior_diagnostic_project:prior.project||null,project_mismatch:uiProject!==(prior.project||helperProject),server_binding_verified:true,server_sha256:createHash('sha256').update(server).digest('hex'),deployed_revision:process.env.RENDER_GIT_COMMIT||null,ui_host:process.env.RENDER_EXTERNAL_HOSTNAME||null};save();
 const ui=new BigQuery({projectId:uiProject,credentials,autoRetry:false,maxRetries:0});
 const old=new BigQuery({projectId:prior.project||helperProject,credentials,autoRetry:false,maxRetries:0});
 // Read only these two successful jobs, never execute their SQL again.
 for(const id of ['oracle_ui_routes_da143f25-c64c-4841-8cd1-8706345c59e6','oracle_ui_routes_4e9314d8-46bd-4a7a-bbeb-d5915c464031']){
  const c={check:'retained_result_parser_control',job_id:id};
  try{
   const j=old.job(id,{location:'US'}),[m]=await bounded(()=>j.getMetadata(),3000);
   assert.equal(m.status?.state,'DONE');assert.ok(!m.status?.errorResult);
   const [rows,next,api]=await bounded(()=>j.getQueryResults({autoPaginate:false,maxResults:51,timeoutMs:2000}),3000);
   const counts={};for(const r of rows)counts[r.kind]=(counts[r.kind]||0)+1;
   const saved=prior.checks?.find(x=>x.job_id===id),savedCounts=Object.fromEntries(Object.entries(saved?.groups||{}).map(([k,v])=>[k,v.records.length]));
   const canonical=x=>JSON.stringify(Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))));
   c.status='read_completed';c.returned=rows.length;c.total_rows=api?.totalRows??null;c.page_complete=!next?.pageToken&&!api?.pageToken&&rows.length<51&&(api?.totalRows==null||Number(api.totalRows)===rows.length);c.retained_kind_counts=counts;c.saved_kind_counts=savedCounts;c.counts_match=canonical(counts)===canonical(savedCounts);
   const retainedRecords=rows.map(r=>JSON.stringify([r.kind,JSON.parse(r.record)])).sort();
   const savedRecords=Object.entries(saved?.groups||{}).flatMap(([kind,g])=>g.records.map(r=>JSON.stringify([kind,r]))).sort();
   c.records_match=c.page_complete&&!!saved&&JSON.stringify(retainedRecords)===JSON.stringify(savedRecords);
   c.query_sha256=createHash('sha256').update(m.configuration?.query?.query||'').digest('hex');
  }catch(e){c.status='unavailable';c.message=clean(e);}out.checks.push(c);save();
 }
 const [dm]=await bounded(()=>ui.dataset(dataset).getMetadata(),4000);const location=dm.location;assert.ok(location);out.destination.location=location;save();
 const subjects={ww:['11737','11795','23150','44905','11549','11593','11594','92837','11634','80797','60637','80795'],usd:['106660','106592','106354','106178','106807','106986','106800','108048','108303','108052','108175','108623']};
 const parents=Object.entries(subjects).flatMap(([s,ids])=>ids.map(id=>`woo:${s}:${id}`));
 const control={source_ref:'woo:ww:114959',decision_id:'247926596db75119da1e545bee604951',target_ref:'shopify:shopify:10549750563143'};out.control=control;
 const variations=prior.checks?.flatMap(c=>c.groups?.variation_keys?.records||[])||[];
 const numeric=[...Object.values(subjects).flat(),'114959','10549750563143','10434361590087','10434361459015','10434361327943','10434361164103','10434341667143','10434341863751','10434363818311','10434363883847','10434364408135',...variations.map(v=>v.variation_id).filter(x=>/^\d+$/.test(x))];
 const pattern=`(?:${control.decision_id}|(?:^|[^0-9])(?:${[...new Set(numeric)].join('|')})(?:[^0-9]|$)|(?i:iron[ -]*maiden|mot[oö]rhead|powerslave|piece[ -]*of[ -]*mind|book[ -]*of[ -]*souls|killers[ -]*eddie|warpig))`;
 async function select(check,query,params={},types={},timeout=6000,bytes='50000000'){
  const c={check,allocated_job_id:'oracle_ui_provenance_'+randomUUID(),query_sha256:createHash('sha256').update(query).digest('hex'),query,params,types};
  if(end-Date.now()<3000){c.status='not_started_deadline';out.checks.push(c);save();return c;}
  out.allocated_queries.push({check,job_id:c.allocated_job_id,project:uiProject,location});save();
  try{
   const [j]=await bounded(()=>ui.createQueryJob({query,params,types,jobId:c.allocated_job_id,location,useLegacySql:false,maximumBytesBilled:bytes,jobTimeoutMs:timeout}),Math.min(timeout+2000,end-Date.now()));c.job_id=j.id;
   const [rows]=await bounded(()=>j.getQueryResults({autoPaginate:false,maxResults:3000,timeoutMs:timeout}),timeout+2000);
   c.status='read_completed';c.rows=rows;
  }catch(e){c.status='unavailable';c.job_id??=c.allocated_job_id;c.message=clean(e);c.errors=(e.errors||[]).slice(0,5).map(x=>({reason:x.reason||null,location:x.location||null,message:clean(x.message)}));const pos=[e.message,...(e.errors||[]).map(x=>x.message)].join(' ').match(/(?:\[|\bat\s+)(\d+):(\d+)/i);c.statement_location=pos?{line:Number(pos[1]),column:Number(pos[2])}:null;}
  out.checks.push(c);save();return c;
 }
 const histories={};
 for(const [kind,table] of [['operation',PRODUCT_MAPPING_OPERATION_TABLE],['outcome',PRODUCT_REVIEW_OUTCOME_TABLE],['identity',PRODUCT_MAPPING_TABLE],['family',PRODUCT_FAMILY_TABLE]]){
  assert.match(table,/^[A-Za-z0-9_]+$/);
  const query=`WITH raw AS (SELECT TO_JSON_STRING(t) record FROM \`${uiProject}.${dataset}.${table}\` t),
   seed AS (SELECT * FROM raw WHERE REGEXP_CONTAINS(record,@pattern)),
   seed_ids AS (SELECT DISTINCT COALESCE(JSON_VALUE(record,'$.decision_id'),JSON_VALUE(record,'$.event_id')) id FROM seed),
   seed_relationships AS (SELECT DISTINCT JSON_VALUE(record,'$.relationship_id') id FROM seed),
   selected AS (SELECT r.* FROM raw r LEFT JOIN seed_ids d ON d.id=JSON_VALUE(r.record,'$.supersedes_decision_id') LEFT JOIN seed_relationships k ON k.id=JSON_VALUE(r.record,'$.relationship_id') WHERE REGEXP_CONTAINS(r.record,@pattern) OR d.id IS NOT NULL OR k.id IS NOT NULL),
   totals AS (SELECT COUNT(*) total_records FROM raw),selected_totals AS (SELECT COUNT(*) matching_records FROM selected),ranked AS (SELECT *,ROW_NUMBER() OVER(ORDER BY record) rn FROM selected)
   SELECT 'inventory' kind,TO_JSON_STRING(STRUCT(total_records,matching_records)) record FROM totals CROSS JOIN selected_totals
   UNION ALL SELECT 'record',record FROM ranked WHERE rn<=501 ORDER BY kind,record`;
  const receiptIds=[...new Set((histories.operation||[]).map(r=>r.decision_event_id).filter(id=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(id)))];
  const scopedPattern=receiptIds.length?pattern+'|(?:'+receiptIds.join('|')+')':pattern;
  const c=await select('ui_persisted_'+kind,query,{pattern:scopedPattern},{pattern:'STRING'});
  if(c.status==='read_completed'){c.inventory=JSON.parse(c.rows.find(r=>r.kind==='inventory').record);c.records=c.rows.filter(r=>r.kind==='record').map(r=>JSON.parse(r.record));c.truncated=Number(c.inventory.matching_records)>c.records.length;delete c.rows;histories[kind]=c.records;save();}
 }
 const refs=[...new Set([...parents,control.source_ref,control.target_ref,...variations.map(v=>v.prefix+v.variation_id),...Object.values(histories).flat().flatMap(r=>[r.source_ref,r.left_ref,r.right_ref]).filter(x=>typeof x==='string'&&x.includes(':'))])];
 assert.ok(refs.length<=501,'Related reference bound; raw evidence preserved');
 const reader=classificationReaderCtes(uiProject),kinds=[['current_identity','cr_map_current','m','LEFT JOIN scope_refs l ON l.ref=m.left_ref LEFT JOIN scope_refs r ON r.ref=m.right_ref WHERE l.ref IS NOT NULL OR r.ref IS NOT NULL'],['current_family','cr_family_current','f','JOIN scope_refs s ON s.ref=f.source_ref'],['routes','cr_routes','r','JOIN scope_refs s ON s.ref=r.source_ref'],['classifications','cr_resolved','c','JOIN scope_refs s ON s.ref=c.subject_ref']];
 const query='WITH '+reader+`,scope_refs AS (SELECT DISTINCT ref FROM UNNEST(@refs) ref),`+kinds.map(([kind,table,a,join],i)=>`a${i} AS (SELECT '${kind}' kind,TO_JSON_STRING(${a}) record,COUNT(*) OVER() available_records,ROW_NUMBER() OVER(ORDER BY TO_JSON_STRING(${a})) rn FROM ${table} ${a} ${join})`).join(',')+' '+kinds.map((_,i)=>`SELECT kind,record,available_records FROM a${i} WHERE rn<=501`).join(' UNION ALL ')+' ORDER BY kind,record';
 const consumption=await select('actual_deployed_report_reader',query,{refs},{refs:['STRING']},12000,'100000000');
 const report={};if(consumption.status==='read_completed'){for(const r of consumption.rows)(report[r.kind]??=[]).push(JSON.parse(r.record));consumption.truncated=consumption.rows.some(r=>Number(r.available_records)>(report[r.kind]?.length||0));save();}
 const rawFamily=histories.family||[],rawIdentity=histories.identity||[];
 let uiIdentity={current:[],activeApproved:[]},uiFamily={current:[],active:[]};
 try{
  uiIdentity=resolveMappingDecisions(rawIdentity.map(r=>({...r,decision_id:r.decision_id||r.event_id,relationship_id:r.relationship_id||relationshipId(r.left_ref,r.right_ref),reviewed_at:r.reviewed_at?BigQuery.timestamp(r.reviewed_at):null})));
  uiFamily=resolveFamilyDecisions(rawFamily.map(r=>({...r,reviewed_at:r.reviewed_at?BigQuery.timestamp(r.reviewed_at):null})));
  out.ui_current={identity:uiIdentity.current,family:uiFamily.current};
 }catch(e){out.ui_resolver_error=clean(e);}

 out.positive_control={deployed_UI_current_active_family:uiFamily.active.some(r=>r.source_ref===control.source_ref&&normalizeClassificationRef(r.shopify_parent_ref)===control.target_ref),raw_decision_found:rawFamily.some(r=>(r.decision_id||r.event_id)===control.decision_id&&r.source_ref===control.source_ref),current_active_family:(report.current_family||[]).some(r=>r.source_ref===control.source_ref&&r.status==='active'),route_consumed:(report.routes||[]).some(r=>r.source_ref===control.source_ref&&r.classification_ref===control.target_ref),named_classification_consumed:(report.classifications||[]).some(r=>r.subject_ref===control.source_ref&&r.classification_type==='collaboration_name'&&r.classification_value==='end')};
 const historyComplete=['identity','family'].every(k=>out.checks.some(c=>c.check==='ui_persisted_'+k&&c.status==='read_completed'&&!c.truncated));
 out.parser_control_passed=out.checks.filter(c=>c.check==='retained_result_parser_control').length===2&&out.checks.filter(c=>c.check==='retained_result_parser_control').every(c=>c.status==='read_completed'&&c.counts_match&&c.records_match);
 const controlPass=Object.values(out.positive_control).every(Boolean)&&historyComplete&&consumption.status==='read_completed'&&!consumption.truncated;
 out.unassigned_decision_history=[...rawIdentity,...rawFamily].filter(r=>![r.source_ref,r.left_ref,r.right_ref].some(ref=>parents.includes(ref)||ref===control.source_ref));
 out.reconciliation=parents.map(ref=>{const decisions=[...rawIdentity.filter(r=>r.left_ref===ref||r.right_ref===ref),...rawFamily.filter(r=>r.source_ref===ref)];const approved=uiIdentity.activeApproved.some(r=>r.left_ref===ref||r.right_ref===ref)||uiFamily.active.some(r=>r.source_ref===ref);const children=variations.filter(v=>v.prefix+v.parent_id===ref).map(v=>v.prefix+v.variation_id);const childDecisions=[...rawIdentity.filter(r=>children.includes(r.left_ref)||children.includes(r.right_ref)),...rawFamily.filter(r=>children.includes(r.source_ref))];const receipts=(histories.operation||[]).filter(r=>r.source_ref===ref&&r.decision_event_id);const linked=[...rawIdentity,...rawFamily].filter(r=>receipts.some(x=>x.decision_event_id===(r.decision_id||r.event_id)));const linkedOther=linked.filter(r=>![r.source_ref,r.left_ref,r.right_ref].includes(ref));const approvedChild=uiIdentity.activeApproved.some(r=>children.includes(r.left_ref)||children.includes(r.right_ref))||uiFamily.active.some(r=>children.includes(r.source_ref));const routes=(report.routes||[]).filter(r=>r.source_ref===ref),classes=(report.classifications||[]).filter(r=>r.subject_ref===ref);return {source_ref:ref,finding:!controlPass?'still_unverified':decisions.length&&approved&&routes.length&&classes.some(c=>c.classification_type==='collaboration_name'&&!['collaboration','collaborations'].includes(c.classification_value))?'existing_decisions_located_and_consumed':!decisions.length&&approvedChild?'existing_approval_under_persisted_variation_key_not_parent_ref':!decisions.length&&linkedOther.length?'persisted_decision_under_other_key_linked_by_UI_receipt':!decisions.length&&!out.parser_control_passed?'still_unverified':!decisions.length?'no_persisted_decision_at_exact_current_UI_ref':'existing_decisions_located_not_currently_consumed',decisions:historyComplete?decisions:null,persisted_variation_refs:children,variation_decisions:historyComplete?childDecisions:null,operation_receipts:receipts,receipt_linked_decisions:linked,ui_current_identity:historyComplete?uiIdentity.current.filter(r=>r.left_ref===ref||r.right_ref===ref):null,ui_current_family:historyComplete?uiFamily.current.filter(r=>r.source_ref===ref):null,routes:consumption.status==='read_completed'&&!consumption.truncated?routes:null,classifications:consumption.status==='read_completed'&&!consumption.truncated?classes:null};});
 out.finding=!controlPass||!out.parser_control_passed&&out.reconciliation.some(r=>r.finding==='still_unverified')?'still_unverified':out.reconciliation.every(r=>r.finding==='existing_decisions_located_and_consumed')?'existing_decisions_located_and_consumed':out.destination.project_mismatch&&out.reconciliation.some(r=>r.decisions?.length)?'existing_decisions_located_in_different_UI_destination':'positive_control_verified_see_individual_findings';
 save();console.log(JSON.stringify({file,previous_evidence_file:backup,destination:out.destination,finding:out.finding,parser_control_passed:out.parser_control_passed,unassigned_decision_records:out.unassigned_decision_history.length,positive_control:out.positive_control,products:out.reconciliation.map(r=>({source_ref:r.source_ref,finding:r.finding,decision_ids:r.decisions?.map(d=>d.decision_id||d.event_id)||null,receipt_linked_decision_keys:r.receipt_linked_decisions.map(d=>({decision_id:d.decision_id||d.event_id,source_ref:d.source_ref||d.left_ref,status:d.status})),variation_decision_ids:r.variation_decisions?.map(d=>d.decision_id||d.event_id)||null,route_targets:r.routes?.map(x=>x.classification_ref)||null,named_classifications:r.classifications?.filter(x=>x.classification_type==='collaboration_name').map(x=>x.classification_value)||null})),unassigned_decision_keys:out.unassigned_decision_history.slice(0,21).map(r=>({decision_id:r.decision_id||r.event_id,status:r.status,source_ref:r.source_ref||r.left_ref,other_ref:r.shopify_parent_ref||r.right_ref,title:r.source_title||r.left_title})),unassigned_keys_display_truncated:out.unassigned_decision_history.length>21,checks:out.checks.map(c=>({check:c.check,status:c.status,job_id:c.job_id||null,inventory:c.inventory||null,truncated:c.truncated??null,counts_match:c.counts_match??null,records_match:c.records_match??null,message:c.message||null,statement_location:c.statement_location||null}))}));
 process.exitCode=controlPass&&out.parser_control_passed?0:1;
}catch(e){out.failure=clean(e);save();console.log(JSON.stringify({file,finding:'still_unverified',error:out.failure}));process.exitCode=1;}
JS

```
