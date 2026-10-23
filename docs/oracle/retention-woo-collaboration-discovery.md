# Historical Woo collaboration product review

The successful trace and denominator evidence is preserved. No further denominator diagnostic, retained-error discovery, completed-result discovery or report replay is needed.

The user confirms all four Iron Maiden rings were listed in both Woo WW and Woo USD, including separate Ready-to-Ship and size listings. This is listing evidence, not proof that every listing has recorded eligible sales. No Woo IDs or approved cross-platform links are invented from that confirmation.

## Discovery scope and exact archive limitation

The prior 1,340-product general review queue cannot answer this request completely: its global top-500 limit can displace collaboration candidates, and its SKU-only proposals can miss historical listings. The focused read now starts from every active governed named collection, independently for WW and USD. It scans all persisted Woo products, product variations and historical order lines, retaining source product IDs, variation/parent IDs, ring sizes, SKU/title variants, current statuses and representative order/line references. It has no publish/status filter and includes catalogue-only products with no retained orders. Separate source product IDs are never merged by stripping Ready-to-Ship or size text.

Candidates come from current persisted classifications (including conflicting evidence), approved product identity/reporting-family routes, source catalogue/variation/order-line SKUs, and historical order-line SKU matches to named Shopify targets. Iron Maiden additionally gets title-only leads for Iron Maiden/Eddie/model references, and Motörhead gets its title leads. Those broad searches run over full product records before display/title-example caps. Exact SKU agreement is not required for discovery. The raw title leads are not certified collection membership and never become approved relationships.

Woo catalogue ingestion replaces both `products` and `product_variations` transactionally on refresh and deletes staging tables (`server.js`, `syncMetorikCatalogue`). Thus these tables are **current state, not an archive**. Deleted products with recorded orders can survive in `order_line_items`. An unsold deleted listing missing from current products, variations and order lines cannot be recovered from those tables. The exact missing evidence in that case is an **existing historical Woo/Metorik catalogue export, pre-migration backup or original migration crosswalk containing store + product ID, variation/parent ID, title, SKU and size/RTS attributes**. A listing date/status and corresponding Shopify parent key corroborate the proposed route. Request that retained record from its owner; do not recollect or infer an ID from a title.

All sales counts are warehouse observations through 2026-10-19. Recorded orders, eligible orders and eligible analytical customers are distinct fields; the entry-range impact counts additionally start on 2022-10-19. The same configured analytical identity and eligibility/refund rules are reused, without calculating first-entry cohorts or retention denominators. Unmatched identities retain their existing semantics. Counts overlap between products/stores and must not be added as unique people. Missing parent-order/date evidence is explicit. Zero recorded eligible sales is not proof of no historical sales.

## Review schema and governance actions

Each review row includes Woo store/product ID and title examples, SKU/size/variation listing records, order counts, customer impact, first/last observed order dates and up to 20 order/line references. Current approved-route evidence and up to 50 historical identity/family decisions (including supersession keys and rejected/revoked decisions) remain visible. Historical recorded statuses are not represented as current approvals; current approved routes come from the shared governance resolver. Classification conflicts and competing SKU parents are flagged.

A unique SKU-supported Shopify parent can be proposed for **graph preview and review**, not approval. Title token overlap only supplies `title_review_leads`; `proposed_target` remains null for title-only matches. The reviewer must choose identity versus reporting-family membership using the existing Product Mapping/Product Families graph-safe workflow. Existing approved routes are inspected/consumed without asking for approval again. No classification, mapping or family decisions are written by this diagnostic.

Each named collection has its own source-specific count and 200-product review quota plus sentinel; no general product queue can displace it. All named catalogue entries remain in the independent summary even with no candidates. Product titles, SKUs, listings, decisions, evidence and reference samples have explicit bounds, and truncation is disclosed. These bounds are not proof that omitted listings never existed. The main retained result includes all per-collection review rows up to that independent quota. The command prints the full Iron Maiden/Motörhead review rows and up to three rows for each other collection, with returned/total counts; complete results remain accessible by the emitted completed job ID, without executing again.

## One focused read-only Render command

Development Google access remains OAuth-blocked; no production Woo IDs or BigQuery pass is fabricated. This command executes only two source-specific product-discovery scripts against existing warehouse/governance tables. It reads no denominator trace and no control/error-discovery jobs. Each script uses one transaction snapshot, eight temporary tables including its result, a reviewed 4.5 GB whole-script cap (nine data statements × 500 MB), unchanged 500 MB statement/15-second statement/50-second job/55-second client limits. It creates no persistent business tables and performs no collection, governance action or snapshot change. Sources retain independent success/error results. No deployment is needed: the artifact is immutable and hash-pinned.

```bash
timeout --signal=TERM --kill-after=5s 75s node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {BigQuery} from '@google-cloud/bigquery';
import {loadBigQueryConfig} from './bigquery/client.js';
import {boundedQuery} from './oracle/bounded-query.js';
const revision='b57c9e5f7b016cbb711932888861bde9c9cdeec1';
const emit=x=>console.log(JSON.stringify({report_replayed:false,denominator_diagnostic_repeated:false,governance_written:false,persistent_business_writes:false,...x}));
const clean=e=>String(e?.message||e||'').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[redacted]').slice(0,4000);
let allocations=0;
try {
 const response=await fetch(`https://raw.githubusercontent.com/lmnopstudios-dot/tgf-bigquery-sync/${revision}/diagnostics/retention-woo-collaboration-discovery.json.gz`,{signal:AbortSignal.timeout(8000),redirect:'error'});assert.ok(response.ok);
 const parts=[];let size=0;for await(const part of response.body){size+=part.length;assert.ok(size<=262144);parts.push(part);}
 const bytes=Buffer.concat(parts);assert.equal(createHash('sha256').update(bytes).digest('hex'),'681980ae09106de57f9994e05ef9f7516b6332caa7553fc6f97c2946f94f235f');
 const artifact=JSON.parse(gunzipSync(bytes,{maxOutputLength:4194304}));
 const {collaborationDiscoveryReview}=await import('data:text/javascript;base64,'+Buffer.from(artifact.review_source).toString('base64'));
 const {project,credentials}=loadBigQueryConfig();assert.equal(project,'gf-full-data');assert.equal(artifact.project,project);
 assert.equal(process.env.ORACLE_CUSTOMER_IDENTITY_MODE,'email_candidate_v2');assert.equal(process.env.ORACLE_CUSTOMER_IDENTITY_DATASET,'customer_identity');assert.equal(process.env.ORACLE_CUSTOMER_IDENTITY_SNAPSHOT,'history-20261022-billing-v3');
 const bq=new BigQuery({projectId:project,credentials,location:'US',autoRetry:false,maxRetries:0});
 const results=await Promise.allSettled(artifact.settings.map(async entry=>{
  const {store,...settings}=entry;let job_id=null;
  try {
   assert.ok(['ww','usd'].includes(store));assert.equal(settings.maximumBytesBilled,'4500000000');assert.equal(settings.scriptOptions.statementByteBudget,'500000000');assert.equal(settings.jobTimeoutMs,50000);
   for(const [key,type]of Object.entries(settings.types))if(type==='DATE')settings.params[key]=BigQuery.date(settings.params[key]);
   const guarded={createQueryJob:async options=>{assert.ok(++allocations<=2);assert.equal(options.query,entry.query);assert.ok(!options.destination&&!options.dryRun);const result=await bq.createQueryJob(options);job_id=result[0].id;emit({check:'woo_product_discovery',store,phase:'allocated',job_id,query_sha256:createHash('sha256').update(options.query).digest('hex')});return result;}};
   const [rows]=await boundedQuery(guarded,settings,{maximumMs:55000});assert.equal(rows.length,1);const r=rows[0];assert.ok(Array.isArray(r.catalogue)&&Array.isArray(r.review_rows));
   const review=collaborationDiscoveryReview(r.review_rows,r.catalogue);
   emit({check:'woo_product_discovery',store,status:'executed_envelope_validated',job_id,catalogue:r.catalogue,unkeyed_iron_maiden_line_leads:r.unkeyed_iron_maiden_line_leads,unkeyed_line_sample_at_bound:r.unkeyed_iron_maiden_line_leads?.length===21});
   for(const c of r.catalogue){
    const selected=review.filter(x=>x.collection_id===c.collection_id);const priority=['658016338247','657969971527'].includes(c.collection_id);
    emit({check:'woo_mapping_review',store,job_id,collection_id:c.collection_id,collection:c.display_name,retained_candidate_products:c.candidate_products,printed:priority?selected.length:Math.min(3,selected.length),independent_review_truncated:Number(c.candidate_products)>200,items:priority?selected:selected.slice(0,3)});
   }
   return true;
  }catch(e){emit({check:'woo_product_discovery',store,job_id,status:'unavailable',message:clean(e),provider_errors:(e.errors||[]).slice(0,5).map(x=>({reason:x.reason,location:x.location,message:clean(x)}))});return false;}
 }));
 emit({phase:'woo_collaboration_discovery_complete',artifact_revision:revision,queries_submitted:allocations,checks:results.map((r,i)=>({store:artifact.settings[i].store,completed:r.status==='fulfilled'&&r.value===true}))});
 if(results.some(r=>r.status!=='fulfilled'||r.value!==true))process.exitCode=1;
}catch(e){emit({status:'unavailable',message:clean(e),queries_submitted:allocations});process.exitCode=1;}
JS
```

## Validation and remaining evidence

Six focused local tests pass: full warehouse inventory roots, per-collection quotas, non-SKU title leads, distinct RTS/size/store keys, listing versus sales semantics, governance conflicts and recorded/eligible count deduplication. The required acceptance and browser gates are running. Generated SQL structure and a SQLite count fixture do not establish BigQuery compatibility. Actual warehouse execution and the resulting Woo→Shopify review list remain pending the focused read; no production product ID is invented here.
