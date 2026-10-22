# Retention mapping and transaction-coverage completion

**Diagnostic follow-up:** the five existing-evidence reads succeeded and remain preserved. The confirmed entry-age `EXISTS`-in-join error is fixed; the mapping error remains independent and requires paginated discovery. Do not rerun the seven-check command below. Use the [single targeted follow-up command](retention-diagnostic-errors-383.md#one-targeted-render-follow-up-command) for retained mapping errors and corrected entry-age execution only.

## Live report baseline: preserve it

Current main includes #382. Production revision `c22df6162b9e1abdd29c8e628cdaab045496961b`, query `f7c52395-3269-4a44-af7d-7f78c1ebb395`, passed acceptance: 99 main item rows, 60 ranking rows, combined synthetic executed/validated, `acceptance_passed=true`. Successful report `279fea44-4f76-4723-9936-a0f39d916a8e` returns combined collaboration comparisons, provisional rates, sitewide baseline, individual items, whole-range rankings and second-order products. These are live successes, not local mocks. No population-scope or rate-rank fix is repeated here; no historical-error diagnostic is rerun.

Scope remains combined TGF; entry 2022-10-19 through 2026-10-19, cutoff 2026-10-19, Europe/London; `email_candidate_v2`, snapshot `customer_identity/history-20261022-billing-v3`. Provisional rates remain available; verified coverage is still unverified. Analytical identities retain unmatched/ambiguous source-local records and possible residual cross-platform double counting.

## Approved routing audit and review workflow

The existing shared classification reader consumes active approved identities, reporting-family memberships and identity-then-family routes before first-order attribution. Grouping consumes approved Shopify parent identity when an unambiguous reporting family is absent. No confirmed bypass in those supported routes has been supplied. Existing archived-line and approved-route regressions remain in place. The new production audit compares resolved source names to the actual classified historical lines and reports `resolved_classification_not_consumed`; a nonzero result needs investigation, never automatic governance approval.

The promised review diagnostic had a separate flaw: it treated absence of a route to a named target as absence of consumed attribution, ignoring an already-governed direct Woo classification. It now inspects the classifications actually consumed on each Woo source line. Directly named but unmapped products still enter review for the missing product/family route, labelled `named_classification_consumed_product_route_missing`; they are not falsely labelled missing collaboration classification. Ambiguous family routes and unresolved classifications remain visible. Explicitly governed core products without a classification conflict are excluded; unclassified products are not assumed core. Approved routes are displayed and never submitted for reapproval.

One consolidated review list is ranked by affected eligible analytical customer records, then orders, across WW and USD. Each entry contains Woo store/ID/title, historical eligible-order count, entry-range affected order/customer counts, current approved routes, classification conflicts, proposed Shopify parent (only one supported candidate), exact normalized SKU evidence, the target's governed collaboration names/existing family references and required governance action. Historical order lines include archived products without live/publication filters. Counts describe purchasing records for the product, not the marginal change in first-purchase retention cohorts; counts overlap across products.

SKU evidence is case/whitespace normalized and is only a review candidate, not proof of equivalence. Multiple targets, an existing different approved target, and classification conflicts are explicit. No title similarity or title stripping proposes a link. A target lacking governed named-collaboration evidence is not proposed as a collaboration product. No candidate or governance decision is written. Products with no supported target remain unattributed, not assigned to a collaboration by guesswork. Missing mappings, missing source-key history, classification conflicts and missing current collection membership are separate evidence states; none establishes “not sold”.

Use `/oracle/product-mappings`: locate the concrete Woo reference, select the proposed Shopify parent, inspect evidence and graph preview, and review the identity versus reporting-family relationship. Preview conflict diagnostics and existing rejection/supersession history remain mandatory. The diagnostic does not invoke service setup/write methods or approve relationships. After a user approves new decisions through the existing workflow, the same source lines and current route resolver can be checked read-only against the same frozen customer snapshot; no order recollection or identity rebuild is needed. A future report execution is a separate user action.

**Production mapping rows are pending the one check below.** The supplied report contains no concrete Woo candidate IDs/SKUs or affected counts, and development Google OAuth has repeatedly failed with 403. This PR prepares the review list and its tests; it does not fabricate a populated list or claim the production mapping audit passed. The output is capped at 500 products plus a sentinel/total count. Truncation is explicit; the independent catalogue inventory remains complete even if the review queue exceeds its bound. Each product includes at most 11 SKU candidates and 20 approved-route references; an array at either cap may omit further references, so the existing graph preview must inspect the full relationship history.

## All 24 named entries in the supplied successful report

This table records the supplied report, not a hard-coded cohort list. Runtime reconciliation still starts from current governed collections and retains the generic collection separately. 18 named entries are included; five have missing historical product evidence and one currently has no products. Missing Woo mappings in source diagnostics do not prove no Woo sales. The check returns independent source-specific reconciliation for every governed entry.

| Source | Reviewed collection | Governed name (as pasted) | Observed first-purchase matches | Supplied status |
|---|---|---|---|---|
| TGF | Harley Davidson | harley_davidson | 93 observed | included |
| TGF | Ārdēo Studios | rdostudios | 253 observed | included |
| TGF | TGF x Emily Malice | tgfxemily_malice | Unknown (missing evidence) | no products |
| TGF | TGF x Cut Rate | tgfxcut_rate | 1 observed | included |
| TGF | TGF X 4Q | tgfx4q | Unknown (missing evidence) | historical product evidence missing cause unverified |
| TGF | Sammi | sammi | 234 observed | included |
| TGF | Royal Enfield | royal_enfield | 5 observed | included |
| TGF | Rolling Stones | rolling_stones | 37 observed | included |
| TGF | Motörhead | mot_rhead | 51 observed | included |
| TGF | Mooneyes | mooneyes | Unknown (missing evidence) | historical product evidence missing cause unverified |
| TGF | Judas Priest | judas_priest | 5 observed | included |
| TGF | Iron Maiden | iron_maiden | 17 observed | included |
| TGF | Ghost | ghost | 6 observed | included |
| TGF | Elfin | elfin | 9 observed | included |
| TGF | Death Spray | death_spray | 1 observed | included |
| TGF | Emily Malice | emily_malice | 10 observed | included |
| TGF | DicE | dice | Unknown (missing evidence) | historical product evidence missing cause unverified |
| TGF | Slayer | slayer | 5 observed | included |
| TGF | Dr. Martens | dr_martens | 90 observed | included |
| TGF | Dark Arts Coffee | darkartscoffee | Unknown (missing evidence) | historical product evidence missing cause unverified |
| TGF | Ozzy Osbourne | ozzy_osbourne | 42 observed | included |
| TGF | END. | end | 54 observed | included |
| TGF | Good Charlotte | good_charlotte | 43 observed | included |
| TGF | P&CO | p_co | Unknown (missing evidence) | historical product evidence missing cause unverified |

Emily Malice and TGF x Emily Malice remain distinct governed name entries in this evidence. No alias or classification is inferred or written. Display names, including Motörhead and Ārdēo Studios, are retained.

## Precisely identifying bounds

The successful native item component returned 99/99 main rows and 60/90 ranking rows. Product rankings deliberately select up to ten products per ranking criterion and show all three windows. The supplied report's generic truncation warning does not itself identify a component. The consolidated check reads only that exact report's retained evidence, returning counts and original outcomes for every retained execution, without replay; its deterministic four-execution bound is explicit.

New report evidence records returned rows, independent row quota and the provider's actual truncation flag per main component. Rendering names the truncated component. Collaboration totals (99 rows), collaboration items (99), baseline (3), yearly baseline (150), ranking array (90), entry-platform diagnostics (300 per component), second-product highlights (10 per cohort/window) and the independent catalogue validation guard (1000) are disclosed separately. A result exactly at a limit is labelled `at bound, omission unverified` unless a provider flag actually proves truncation. Top-10 highlights are bounded selections, not a complete product inventory. The catalogue guard is a validation safeguard, not an item output quota.

Collaboration totals and catalogue reconciliation run independently of item quotas and are not displaced by ranking or item rows. The new diagnostic also keeps its 500-product review queue separate from all source-specific collection entries. No execution deadlines or byte limits for the business report change, and its generated SQL is unchanged.

## Smallest concrete coverage verification

Continue the existing [coverage verification contract](retention-coverage-verification-plan.md) rather than searching more datasets for a certificate. The consolidated check reads the actual finance/customer update runs around the known unresolved interval, existing collector records and metadata for the exact retention input tables. It does not read email checkpoints as transaction coverage. Existing source inventory/export artifacts must be supplied first by the source owner if retained outside these controls; this bounded warehouse read cannot prove none exist elsewhere.

1. **Bootstrap:** obtain existing exhaustive original order-key inventories and completion/pagination manifests for Woo WW, Woo USD and native Shopify lookback through the cutoff, including archived/deleted-record handling. Match against the actual retention tables: Woo `orders` and `order_line_items`; Shopify `order_locations`, `order_financials`, `order_customers` and `order_line_items`. Warehouse row counts and last-modified times are observations only. Neither the full Shopify sync nor the Woo sync persists an immutable exhaustive source-key/state manifest in the known control tables; retained responses/logs/exports may supply one and must be checked before any new source request.
2. **Updates:** for the explicit half-open delta `[2026-10-19T14:17:24.265Z, 2026-10-19T23:00:00Z)`, compare an existing exhaustive source inventory of created OR updated orders, including old orders updated in the interval. Match native order IDs to warehouse IDs with duplicate, source-only and warehouse-only counts. Finance `succeeded` runs establish atomic promotion of accessible location/financial/refund updates, not bootstrap completeness or customer/line maintenance. Customer **scheduled** windows may support eligibility maintenance after bootstrap; `repair` windows only repair known missing IDs and must not form a completeness chain. Read records first; absence/failure of a run is not proof of missing transactions because other writers exist.
3. **Eligibility and refunds:** compare original timestamp, channel, import app/provenance, financial status, cancellation, original total, total refunds, currency, customer-record presence/guest state and line/product keys. Use exact decimal normalization and reject duplicate keys. Compare eligible sets only after matching the complete unfiltered source/warehouse key universe. A current API response cannot establish eligibility as of 2026-10-19; require an existing cutoff snapshot or auditable status/refund events, otherwise leave historical cutoff state unverified.
4. **Migration continuity:** obtain evidenced Woo last-new-order and later-adjustment boundaries separately for each store, plus Shopify native bootstrap/launch inventory and complete imported-copy exclusion keys. Do not infer retired/no-sales periods from last activity or a public migration date. A source period is unsupported only with actual access/lifecycle evidence; otherwise mark it unknown. Supported in-store Shopify orders remain included; Square is outside this report's supported population.

**Required action:** the data/source owner supplies the retained source inventory/manifests and state artifacts above (or identifies exactly the missing partition/field), alongside the bounded warehouse output. Compare locally without uploading source inventories to production. Produce one discrepancy summary per declared source/store/channel/interval: both key counts, duplicate/source-only/warehouse-only counts, field mismatches and eligibility-set differences, with artifact hashes and completeness/as-of declarations. Stop any partition lacking exhaustive inventory, required state or lifecycle facts. No collector restart, new collection or repair is authorized. If no retained source inventory exists, the next proposal is a separately authorized bounded read-only source-key/state export for exactly that partition, not automatic recollection.

A pass establishes matching existence and eligibility state only for that declared inventory/interval/snapshot semantics. An update delta pass cannot establish the earlier bootstrap. Complete bootstrap plus evidenced maintenance, cutoff state and lifecycle evidence may support proposed source intervals for owner review. The current linked coverage consumer requires the common certified interval across all three sources; an evidenced migration handoff union must not be silently treated as that intersection. No certificate or configuration is written by this work. Provisional rates stay available regardless of this unresolved evidence.

## Motörhead and Iron Maiden: zero 360-day denominator investigation

The supplied successful report has 51 Motörhead and 17 Iron Maiden entry customers. Each has three observed repeats within 360 days, but zero provisional age-qualified entries. This means the reported 360-day rate is unavailable; it does **not** mean zero returns. Product-range age cannot establish the age of first-observed eligible customer entries. The zero denominator is not yet verified as correct, and the Woo mapping gaps are not yet proven to cause it.

The consolidated command below now includes an independent `collaboration_entry_age_trace` for governed collection IDs 657969971527 and 658016338247. These are diagnostic subjects, not a replacement cohort catalogue. It reuses the actual linked-history, approved-route, resolved-classification, eligibility, global first-entry and retention-member SQL. No business calculation is changed speculatively.

For each collection and combined/WW/USD/Shopify view, the trace returns order counts, eligible analytical customer counts, earliest/latest purchase dates and earliest/latest linked first-entry dates at each stage: governed product history; actual consumed named classification; eligible purchases; import/cancellation/status/full-refund/cutoff exclusions; matched/unmatched/ambiguous identity; first purchase versus an earlier purchase of another range; first entry before the requested range; actual cohort membership; age-qualified 90/180/360 entries; and observed versus age-qualified 360-day repeats. The inclusive last entry date for 360-day eligibility is **2025-10-24**, using London calendar dates.

Stages overlap and must not be added. Raw-history customer counts describe only records with an eligible linked order; source-local registered profiles are separate and do not invent guest identities. At cohort-member stages, “orders” identifies deduplicated customer entries. Unavailable governed target evidence produces unknown counts rather than fabricated zeros. A separate product-route inventory includes archived historical lines, approved route details and separately labelled exact persisted-SKU candidates. Candidate-only history never becomes governed collaboration membership. The product inventory is bounded at 200 with a sentinel and explicit truncation; the stage grid is independent of that limit.

Interpretation: older governed history absent from consumed classifications points to attribution; consumed eligible old purchases with earlier other-product entries can correctly be excluded from first-purchase cohorts; first entries before scope are correctly outside scope. Actual cohort entries on or before 2025-10-24 with a zero age-qualified count would establish a calculation defect. No such production conclusion is claimed before the trace executes. Missing historical warehouse lines also cannot establish that a collaboration was not sold.

Regressions execute the generated membership/aggregation SQL through a SQLite compatibility harness for **both** collaborations: old Woo entry followed by Shopify return, duplicate entry lines, recent entries with observed returns and no aged denominator, London date boundary, and global first-entry assignment before source/date filters. Additional trace-stage fixtures distinguish unapproved SKU candidates, earlier other-range entries and exclusion reasons. These are local SQL executions, not BigQuery compilation or production evidence. The report SQL and successful live acceptance remain unchanged.

## One consolidated bounded Render check

The command below is pinned to this source/artifact, uses deployed dependencies, and can run without deploying the PR. It reads the exact current report once, known ingestion records and table metadata, and one transaction-derived mapping audit. Mapping uses ten temporary tables in an owned read-only business-data transaction (nine cached inputs plus aggregate); no persistent table, state or governance writes. It never calculates/replays the report. Independent checks emit as they finish.

Bounds: five SELECT jobs, 100 MB billed each and 10-second warehouse/12-second client limits; two independent scripts (mapping and entry-age trace), each with a 50-second warehouse/55-second client limit, 15 seconds per statement, 500 MB per data statement (mapping: 11 statements/5.5 GB; entry-age trace: 12 statements/6 GB), 501 review products, 1000-entry catalogue validation per source. Five control reads include exact request inventory (four executions plus sentinel), finance/customer run rows (500 plus sentinel), collector rows (100 plus sentinel), and exact table metadata. These diagnostic bounds do not change production report limits. The command does not query source APIs, perform deployment, or certify coverage.

```bash
timeout --signal=TERM --kill-after=5s 75s node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {BigQuery} from '@google-cloud/bigquery';
import {loadBigQueryConfig} from './bigquery/client.js';
import {boundedQuery} from './oracle/bounded-query.js';
import {safeReadFailure} from './oracle/read-failure.js';
import {reconcileRetentionCatalogue} from './oracle/retention-catalogue.js';
let stage='pinned_artifact';
try {
 const revision='0af73bf2d2e294d13ea258940b13e5ae889f238c';
 const response=await fetch(`https://raw.githubusercontent.com/lmnopstudios-dot/tgf-bigquery-sync/${revision}/diagnostics/retention-mapping-coverage.json.gz`,{signal:AbortSignal.timeout(8000),redirect:'error'});
 assert.ok(response.ok,'Pinned artifact unavailable');
 const chunks=[];let size=0;
 for await(const chunk of response.body){size+=chunk.length;if(size>262144)throw Error('Compressed artifact bound');chunks.push(chunk);}
 const bytes=Buffer.concat(chunks);
 assert.equal(createHash('sha256').update(bytes).digest('hex'),'3b606816a4f31a1294bf2c28c8fc5085a292ec8a6924d88838b2b0dbc8a7ef22');
 const artifact=JSON.parse(gunzipSync(bytes,{maxOutputLength:4194304}));
 const {project,credentials}=loadBigQueryConfig();
 assert.equal(project,artifact.project);
 assert.equal(process.env.ORACLE_CUSTOMER_IDENTITY_MODE,'email_candidate_v2');
 assert.equal(process.env.ORACLE_CUSTOMER_IDENTITY_DATASET,'customer_identity');
 assert.equal(process.env.ORACLE_CUSTOMER_IDENTITY_SNAPSHOT,'history-20261022-billing-v3');
 assert.equal(process.env.ORACLE_JOB_DATASET||'commerce','commerce');
 const {evidenceReader}=await import('data:text/javascript;base64,'+Buffer.from(artifact.runner_source).toString('base64'));
 const read=evidenceReader({boundedQuery,safeReadFailure,reconcileRetentionCatalogue});
 for(const settings of [artifact.mapping_settings,artifact.trace_settings])for(const [key,type]of Object.entries(settings.types))if(type==='DATE'&&settings.params[key]!=null)settings.params[key]=BigQuery.date(settings.params[key]);
 const native=new BigQuery({projectId:project,credentials,location:'US',autoRetry:false,maxRetries:0});
 let allocations=0;
 const bigquery={createQueryJob:async settings=>{
  assert.ok(++allocations<=7,'Warehouse allocation bound');
  const match=artifact.ingestion_queries.find(q=>q.query===settings.query);
  const mapping=settings.query===artifact.mapping_settings.query;
  const trace=settings.query===artifact.trace_settings.query;
  assert.ok(match||mapping||trace,'Unexpected warehouse query');
  assert.ok(!settings.destination&&!settings.dryRun,'Unexpected persistent destination or dry run');
  const check=match?.check||(trace?'collaboration_entry_age_trace':'consolidated_mapping_review');
  try{
   const result=await native.createQueryJob(settings);
   console.log(JSON.stringify({phase:'existing_evidence_job',check,job_id:result[0].id,query_sha256:createHash('sha256').update(settings.query).digest('hex')}));
   return result;
  }catch(e){console.log(JSON.stringify({phase:'query_submission_failed',check,...safeReadFailure(e,'diagnostic')}));throw e;}
 }};
 stage='consolidated_existing_evidence';
 const result=await read({bigquery,project,artifact,onCheck:check=>console.log(JSON.stringify(check))});
 console.log(JSON.stringify({phase:'consolidated_evidence_complete',deployed_revision:process.env.RENDER_GIT_COMMIT||null,artifact_revision:revision,scope:result.scope,checks:result.checks.map(c=>({check:c.check,status:c.status})),warehouse_jobs:allocations,report_replayed:false,governance_written:false,coverage_certified:false}));
 if(result.checks.some(c=>c.status!=='read_completed'))process.exitCode=1;
}catch(e){
 console.log(JSON.stringify({status:'unavailable',diagnostic_stage:stage,...safeReadFailure(e,'diagnostic'),report_replayed:false,governance_written:false,coverage_certified:false}));process.exitCode=1;
}
JS
```

## Validation status

All 831 tests pass in the required Oracle acceptance gate (21 central conversations and 59 provider/delivery suites). Desktop/mobile browser gates pass, including durable and activated-identity refresh. The diagnostic tests use mocked warehouse I/O, SQL structure checks and generated membership/aggregation SQL executed through the SQLite compatibility harness described above; these are not live BigQuery execution or a populated production mapping list. All twelve business-report full SELECT settings and synthetic query shapes remain identical to current main; existing live acceptance is preserved. The five successful existing-evidence reads remain preserved. Corrected entry-age execution, retained mapping-error discovery and concrete source-inventory comparison remain pending the targeted command. The published compressed artifact was fetched back from its immutable commit and its SHA-256 verified against the command above.
