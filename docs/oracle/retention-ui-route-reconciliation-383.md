> Current status: inspected-operation source-conversion investigation closed. Preserve Square approvals and the Woo T-shirt no-equivalent outcome. Use the [current Woo review list](woo-review-and-source-receipts-383.md); commands below are archived, not further requested diagnostics.

# Reconcile existing Product Mapping approvals with retention

> Latest live result: both reads completed, but returned no matching decisions for the 24 subjects. The resolver fixes are not a demonstrated solution for these products. Use the [UI destination/positive-control investigation](product-ui-decision-provenance-383.md#one-bounded-ui-destination-and-positive-control-read); do not rerun the empty-scope command below.

Continue draft #383. The supplied WW/USD discovery succeeded; do not repeat it or the completed denominator trace. No new relationship is proposed for approval here. The compact Iron Maiden/Motörhead rows omit decision history: `approved_route_present:false` from that diagnostic is not proof that the UI has no saved approval.

## Confirmed shared resolver defects

1. **Family current state:** the UI's `resolveFamilyDecisions` and shared `productFamilyCtes` select the newest non-superseded decision **per source product**. Classification SQL duplicated this logic with `PARTITION BY membership_id`. Legacy null membership IDs collapsed unrelated products; different historical memberships for one source could instead survive together and cause false ambiguity. Classification/reporting now uses `productFamilyCtes` directly, including current status and supersession.
2. **Legacy identity keys:** the UI uses a saved relationship ID or `relationshipId(left_ref,right_ref)`. SQL used a candidate ID as fallback, which could collapse unrelated approved relationships. SQL now derives the same sorted-endpoint SHA-256 key (one NUL byte separator, lowercase first 24 hex characters). Candidate IDs never define identity relationships.

3. **UI timestamp wrappers:** BigQuery returns `TIMESTAMP` fields as `{value: ISO}` objects. `String(wrapper)` is `[object Object]`, so the UI's chronological sort could instead choose by decision ID. Both in-process resolvers now read the timestamp value before applying the existing decision-ID tie-breaker. A regression uses real `BigQuery.timestamp` wrappers, with an older approved `z-old` and newer revoked `a-new`.

These are verified source/fixture defects. Their causal contribution for the specific production products remains pending the narrow persisted-decision read below. A current UI decision is not written, revoked, changed or reapproved by this fix. Graph approval safeguards are unchanged. A reporting family remains a grouping/classification route, never a canonical identity edge.

## Exact subjects from successful discovery

| Iron Maiden ring | Woo WW | Woo USD | WW recorded / eligible orders | USD recorded / eligible orders |
|---|---:|---:|---:|---:|
| Powerslave Eddie | 11737 | 106660 | 56 / 54 | 4 / 4 |
| Piece of Mind Eddie | 11795 | 106592 | 26 / 25 | 7 / 7 |
| Killers Eddie | 23150 | 106354 | 19 / 19 | 7 / 7 |
| Book of Souls Eddie | 44905 | 106178 | 14 / 14 | 1 / 1 |

| Motörhead listing | Woo WW | Woo USD | WW recorded / eligible orders | USD recorded / eligible orders |
|---|---:|---:|---:|---:|
| Old Warpig Ring | 11549 | 106986 | 91 / 89 | 10 / 10 |
| Warpig Ring | 11593 | 106807 | 71 / 70 | 14 / 14 |
| Ace of Spades Ring | 11594 | 106800 | 29 / 29 | 10 / 9 |
| Warpig Pendant | 92837 | 108048 | 33 / 33 | 4 / 4 |
| Old Warpig Pendant | 11634 | 108303 | 3 / 3 | 1 / 1 |
| Ace of Spades Anniversary T-shirt | 80797 | 108623 | 5 / 3 | 0 / 0 |
| Bomber Anniversary Pendant | 60637 | 108175 | 0 / 0 | 0 / 0 |
| Ace Anniversary Pendant | 80795 | 108052 | 0 / 0 | 0 / 0 |

Counts are supplied discovery evidence, not a fresh order read, customer counts, certified coverage, or proof of no sales outside retained records. Titles describe the review subjects; they never establish a product relationship. Preserve original discovery jobs `a68390f8-1438-4581-ab4b-8c88233a293b` and `cf5bdbdf-15b0-4ce1-b08d-f112861bfe32`.

The supplied full discovery rows already show working approved GID family routes for END. and Elfin (for example END. WW `114959` → Shopify Product GID `10549750563143`). GID normalization is therefore not assumed to be universally broken; its existing parent/variant distinction is preserved.

## Routing contract and remaining evidence

The report constructs Woo refs from **store + order-line parent product ID**. WW and USD never collapse on a numeric ID; persisted variation keys are inspected separately. A saved approval on a variation is not silently promoted to a parent. Shopify numeric product IDs and Product GIDs normalize only when reading classification/reporting routes; ProductVariant GIDs are not parent products. Persisted raw decision keys are resolved before normalization, matching the UI.

Current approved identity edges and active reporting families feed `cr_routes`; governed product/collection classifications feed `cr_resolved`, with conflicts excluded. The actual retention path consumes those classifications in `classified_lines`, then uses `retention_reporting_lines` and `entry_matches`. Family grouping preserves source identity and customer deduplication. No title matching, new transitive relationship, customer link or governance decision is introduced.

For each of the 24 parent refs (and their stored variation keys from both catalogue and parent-ID-filtered historical line records), the narrow read saves raw decision histories, deployed UI resolver results (with BigQuery timestamp wrappers restored), current SQL decisions, normalized routes, resolved/conflicting classifications, and target classification evidence, including raw product-classification history and current collection decisions. Raw histories include same-relationship records and superseding pointers, with independent row-bound disclosure. It also reads same numeric keys across namespaces to expose incorrectly stored namespaces rather than conflating them. A second independent SELECT evaluates **deployed** classification SQL. Comparing these with corrected SQL distinguishes persisted approval, status/supersession, representation/namespace mismatch, variation-only approval, classification conflict and resolver consumption.

If a bounded history is truncated, no absence conclusion is supported. An active relationship lacking a consumed classification needs routing/classification investigation, not reapproval. If a route traverses other approved products, inspect those saved endpoints before proposing any change; this fix does not invent a closure. Only complete persisted evidence establishing that no valid relationship exists would justify a new graph-safe review candidate.

Production Google access remains blocked in this development environment (previous OAuth 403). The exact unresolved fact is **which current persisted UI decision and governed classification each supplied source ref resolves to, and how deployed versus corrected SQL consume it**. Discovery titles, age of the range and compact `approved_route_present` flags cannot answer that fact.

## Verification

`test/product-route-resolver.test.js` executes generated identity/family current-state SQL on local SQLite fixtures, compares it with the real UI pure resolvers, and verifies all three linked report shapes consume the shared reader. Fixtures cover all eight Iron Maiden refs, Motörhead in both stores, legacy null keys, replacement, revocation/supersession and preserved namespaces. Mock transport tests cover independent failures and row bounds.

`test/product-route-report-sql.py` executes the actual generated classification/family/entry CTEs and the exact narrow diagnostic against synthetic persisted histories using DuckDB/sqlglot translation. All 24 WW/USD fixture products reach the expected collaboration and family/identity key; repeated size lines deduplicate; an unmapped other-store key and variation remain excluded. Run with `PYTHONPATH=/tmp/oracle-sql-tools python3 test/product-route-report-sql.py` after installing `duckdb==1.5.6 sqlglot==30.23.0` into that test dependency directory. This is local translated execution, **not BigQuery compilation or production acceptance**.

Historical live report and compilation successes remain evidence for their original artifacts. Shared resolver SQL intentionally changes all current report shapes, so historical compilation hashes are preserved but not claimed as validation of these new shapes. Rebuilt review/manifests match the new shared reader. Entry dates, snapshot, identity settings, provisional/verified denominator rules, exclusions and execution budgets remain unchanged. No report replay, collection or data/governance writes occur.

Prior artifact local gates: **848/848 acceptance tests passed** (21 central conversations, 62 regression suites); desktop/mobile browser acceptance passes, including durable refresh and activated-identity refresh. The prior six focused resolver/audit regressions passed. The diagnostic follow-up now passes **851/851 required acceptance tests**, all nine focused resolver/audit/command regressions, and desktop/mobile browser gates including durable and activated-identity refresh. The complete documented command was exercised with mocked fetch/BigQuery transport to verify preservation of previous evidence, pre-submission job allocation, SQL/error positions and independent null-versus-empty results. This mock is not live BigQuery execution. The published pinned artifact was fetched back and its SHA-256 verified. The Render command was syntax-checked, not executed against production from this environment.

## Confirmed shared diagnostic failure and correction

The user reports both `persisted_and_candidate_routes` and `deployed_routes` failed with BigQuery's unsupported correlated-subquery error. Neither returned decision evidence. This does **not** establish a business-resolver regression or missing approvals.

The builder shared by both paths used table-subquery scope predicates, including `left_ref IN (SELECT ref FROM scope_refs) OR right_ref IN (...)`, nested relationship/history selection and superseder membership tests. Replace these with explicit joins to unique source refs, numeric-key sets, relationship keys, decision keys, target refs and classification refs. OR branches use two left joins to unique keys and one disjunctive null check: a history record matching both endpoints, a relationship and its supersession marker, or repeated variation evidence still appears once per stored history row. Physical duplicate history rows remain visible. Scope sets retain namespaces; raw same-numeric-key history still exposes namespace mistakes without treating them as approved source routes. Superseding records outside the immediate source scope remain included by decision-key joins.

No `IN (SELECT ...)` or `EXISTS (SELECT ...)` table predicate remains in either generated path. The shared business reader/resolvers, report SQL, identity snapshot, prior successful discovery and denominator trace are unchanged by this follow-up. Keyed-join execution and multiset comparisons pass on translated local fixtures (including both scoped endpoints, repeated variation keys, duplicate history rows, cross-store keys and outside-scope superseders). This does **not** prove BigQuery compatibility.

Job IDs are allocated and saved before submission. Submission failures retain the allocated ID even if the SDK never returns a job object, and report that distinction. Errors retain provider reason, structured error locations and parsed SQL line/column. The command saves the exact generated SQL and its SHA-256 for both paths. Before replacing the existing evidence file, it copies that file to a private timestamped backup and records its path; it never discards the previous failures. Successful checks and raw SQL evidence survive an independent query or UI-evaluation failure. A failed/truncated check produces null per-product evidence, never fabricated empty approval lists.

**Live execution is still pending.** No mapping or reconciliation conclusion is supported until the corrected checks actually complete in BigQuery. Do not replay discovery or the report, retrieve historical errors again, or reapprove relationships. Use only the corrected command below; the earlier pinned command is superseded.

## One narrow read-only Render command

Run from the deployed `src` directory. This uses deployed BigQuery credentials, UI resolvers and classification SQL, plus a hash-verified corrected artifact. Two independent SELECTs in US, each capped at 250,000,000 bytes and 20 seconds of warehouse time; 65-second outer bound. Historical line reads select only distinct parent/variation product keys for these exact IDs, including deleted catalogue variations; no order IDs, customers, sales aggregation or transaction population is queried. No denominator, discovery rerun, report replay, setup or DDL. Each kind returns at most 501 records and reports its true available count. The private local evidence file is saved after each completed check, preserving a successful read if the other fails. The final per-parent reconciliation and raw variation/decision evidence are in `/tmp/oracle-ui-product-routes-383.json`; terminal output contains counts, job IDs and any bounded errors. The file includes up to 501 records per kind (at most 6,000 rows per SELECT); raw evidence survives even if deployed UI evaluation fails. Production execution limits are unchanged.

```sh
timeout --signal=TERM --kill-after=5s 65s node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {writeFileSync,existsSync,statSync,copyFileSync,chmodSync,constants} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {BigQuery} from '@google-cloud/bigquery';
import {loadBigQueryConfig} from './bigquery/client.js';
import {classificationReaderCtes,classificationRefSql} from './oracle/classification-reader.js';
import {resolveMappingDecisions,resolveFamilyDecisions,relationshipId} from './oracle/product-mapping.js';
const file='/tmp/oracle-ui-product-routes-383.json';
const evidence={read_only:true,report_replayed:false,production_data_writes:false,
  deployed_revision:process.env.RENDER_GIT_COMMIT||null,checks:[]};
process.umask(0o077);
const save=()=>writeFileSync(file,JSON.stringify(evidence),{mode:0o600});
let initialized=false;
try {
 if(existsSync(file)){
  assert.ok(statSync(file).size<=16777216,'Existing evidence exceeds backup bound; left unchanged');
  const backup=file+'.previous-'+Date.now();
  copyFileSync(file,backup,constants.COPYFILE_EXCL);chmodSync(backup,0o600);
  evidence.previous_evidence_file=backup;
 }
 save();initialized=true;
 const revision='561a9f52046635c75c1859d613dcdbf0c1ae322d';
 const response=await fetch(`https://raw.githubusercontent.com/lmnopstudios-dot/tgf-bigquery-sync/${revision}/diagnostics/retention-ui-route-reconciliation.json.gz`,{signal:AbortSignal.timeout(8000),redirect:'error'});
 assert.ok(response.ok,'Pinned artifact unavailable');
 const chunks=[];let size=0;
 for await(const chunk of response.body){size+=chunk.length;assert.ok(size<=65536,'Artifact bound');chunks.push(chunk);}
 const bytes=Buffer.concat(chunks);
 assert.equal(createHash('sha256').update(bytes).digest('hex'),'95d74a93dce07827c4df7f5ea9e946dc55b725d43b0e9aa30a776d95b6e1ad1d');
 const a=JSON.parse(gunzipSync(bytes,{maxOutputLength:262144}));
 const load=source=>import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
 const [{readUiRouteReconciliation},{uiRouteReconciliationSql}]=await Promise.all([load(a.runner_source),load(a.query_builder_source)]);
 const {project,credentials}=loadBigQueryConfig();
 assert.match(project,/^[A-Za-z0-9_-]+$/);
 const candidateQuery=a.candidate_query.replaceAll('`'+a.project+'.','`'+project+'.');
 const deployedQuery=uiRouteReconciliationSql(project,{reader:classificationReaderCtes(project),normalizeRef:classificationRefSql,raw:false});
 assert.ok(!/\b(?:CREATE|INSERT|UPDATE|DELETE|MERGE)\b/i.test(candidateQuery+deployedQuery),'SELECTs only');
 evidence.artifact_revision=revision;evidence.subjects=a.subjects;evidence.project=project;evidence.location='US';
 evidence.queries=Object.fromEntries(Object.entries({persisted_and_candidate_routes:candidateQuery,deployed_routes:deployedQuery}).map(([check,query])=>[check,{query,sha256:createHash('sha256').update(query).digest('hex')}]));
 evidence.allocated_queries=[];save();
 const result=await readUiRouteReconciliation({project,candidateQuery,deployedQuery,jobIdFactory:randomUUID,
  onAllocated:allocation=>{evidence.allocated_queries.push(allocation);save();},
  bigquery:new BigQuery({projectId:project,credentials,location:'US',autoRetry:false,maxRetries:0}),
  resolveMappingDecisions:history=>resolveMappingDecisions(history.map(r=>({...r,decision_id:r.decision_id||r.event_id,relationship_id:r.relationship_id||relationshipId(r.left_ref,r.right_ref),reviewed_at:r.reviewed_at?BigQuery.timestamp(r.reviewed_at):null}))),
  resolveFamilyDecisions:history=>resolveFamilyDecisions(history.map(r=>({...r,reviewed_at:r.reviewed_at?BigQuery.timestamp(r.reviewed_at):null}))),
  onCheck:check=>{evidence.checks.push(check);save();}});
 Object.assign(evidence,result);
 const candidate=result.checks[0],deployed=result.checks[1];
 const rows=(c,kind)=>c?.groups?.[kind]?.records||[];
 const complete=c=>c?.status==='read_completed'&&!c.truncated;
 const scoped=(c,kind,key,ref)=>complete(c)?rows(c,kind).filter(r=>r[key]===ref):null;
 evidence.reconciliation=Object.entries(a.subjects).flatMap(([store,ids])=>ids.map(id=>{
  const ref=`woo:${store}:${id}`;
  return {source_ref:ref,evidence_status:{corrected_sql:complete(candidate)?'complete':'unavailable_or_truncated',deployed_sql:complete(deployed)?'complete':'unavailable_or_truncated',deployed_ui:candidate.ui_evaluation_complete?'complete':'unavailable'},
   ui_current_identity:candidate.ui_evaluation_complete?(candidate.ui_current?.identity||[]).filter(r=>r.left_ref===ref||r.right_ref===ref):null,
   ui_current_family:candidate.ui_evaluation_complete?(candidate.ui_current?.family||[]).filter(r=>r.source_ref===ref):null,
   corrected_routes:scoped(candidate,'routes','source_ref',ref),
   deployed_routes:scoped(deployed,'routes','source_ref',ref),
   corrected_classifications:scoped(candidate,'resolved_classifications','subject_ref',ref),
   deployed_classifications:scoped(deployed,'resolved_classifications','subject_ref',ref),
   corrected_conflicts:scoped(candidate,'classification_conflicts','subject_ref',ref)};
 }));
 save();
 console.log(JSON.stringify({file,previous_evidence_file:evidence.previous_evidence_file||null,read_only:true,report_replayed:false,subjects:evidence.reconciliation.length,
  checks:result.checks.map(c=>({check:c.check,status:c.status,job_id:c.job_id,allocated_job_id:c.allocated_job_id,job_returned:c.job_returned??null,
   provider_reason:c.provider_reason||null,statement_location:c.statement_location||null,errors:c.errors||[],truncated:c.truncated??null,
   groups:Object.fromEntries(Object.entries(c.groups||{}).map(([k,v])=>[k,{returned:v.records.length,available:v.available}])),
   ui_evaluation_complete:c.ui_evaluation_complete??null,
   http_status:c.http_status||null,message:c.message||c.ui_evaluation_error||null}))}));
 process.exitCode=result.checks.some(c=>c.status!=='read_completed'||c.truncated||c.ui_evaluation_complete===false)?1:0;
}catch(e){
 evidence.failure=String(e.message||e).replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[redacted]').slice(0,300);if(initialized)save();
 console.log(JSON.stringify({file,read_only:true,status:'unavailable',message:evidence.failure}));process.exitCode=1;
}
JS
```
