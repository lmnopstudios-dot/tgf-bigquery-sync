# Confirmed generated SQL regression at 05b6aef

Request 15118146-147f-480c-90f7-4b21d27182f8 executed as job
44db728a-2f95-4651-9404-97a5aafc5e33, attempt 1, on
05b6aef9a5d30f2878fb6f38cecf8bb212629641. The complete supplied retained
outcomes are committed in test/fixtures/retention-sql-15118146/retained-outcomes.json.
All nine source/components rejected population_query with invalidQuery/sql_syntax;
none retained a warehouse job ID or provider message. No further retained-error
read is needed. Current deployed revision is separate from this historical execution.

## Reconstruction and actual invalid expressions

The source factory at that revision is customerJourneySql, with orderLinks=true,
customer_identity/history-20261022-billing-v3, then applyCustomerIdentitySql and
finally decomposedCohortSql. Raw factory SELECT line numbers do not match the
retained errors; the linked transactional execution scripts do. Project is
gf-full-data. Every source retains the cross-source linkage history, with cohort
entry source/store filtering after linkage and sequencing.

The nine complete script hashes and offending lines were captured before editing
and committed in locations.json. The regression test reverses exactly the two
source corrections and reconstructs every complete historical hash and position.
It then checks the corrected linked scripts. This is source reconstruction,
not a BigQuery parser test or successful warehouse execution.

| Shape (identical at WW, USD, Shopify) | Reported position | Expression at that position | Correction |
| --- | --- | --- | --- |
| Collaboration | 254:108 | `r'^(?:gid://shopify/Product/)?([0-9]+)(p.second_order_products...` | Use a replacement callback to insert catalogue SQL literally. |
| Item | 277:264 | `missing_line_customers` after `COALESCE(pc.missing_line_customers,0)` inside `STRUCT(...)` | Add `AS` before all three explicit field aliases. |
| Baseline | 267:228 | Same `STRUCT` alias expression | Same shared correction. |

The catalogue regex originally ends in `$'`. In a JavaScript String.replace
replacement string, `$'` expands to the suffix after the matched text. It spliced
the original final projection into the middle of the raw SQL string literal,
removing the intended regex terminator and catalogue suffix. A replacement
function returns the text literally, preserving the regex and catalogue query.

The new supplemental attribution STRUCT used `STRUCT(COALESCE(...) field,...)`.
GoogleSQL named expressions require `AS field` in STRUCT constructors. Correct
all three fields: missing_line_customers, unidentified_product_customers and
untitled_product_customers. The first alias is exactly at both reported columns.
After repairing the earlier catalogue corruption, this shared STRUCT correction
also applies to collaboration calculations.

The last numerical report revision a64543c1052e35e977a11c44e69ea7a8998396ef
had neither the new catalogue insertion nor the supplemental coverage STRUCT.
The linked identity/decomposition mechanism is retained. Only the two generation
expressions change in application source. Scope/denominators, identity guards,
import exclusions, catalogue routes, display names, independent component limits
and partial-result behavior are preserved. No coverage is certified by this fix.

## Validation and limitations

Five new local tests pass, including historical reconstruction, all nine linked
query shapes, exact generated artifact equality, and an explicitly mocked runner
failure-isolation test. The previously prepared synthetic probe was also missing
a binding for within_days; bind it as nullable INT64 to exercise the actual SQL.
The opt-in live test now uses the same full validation cases and runner as the
Render command, including production retentionRows validation for synthetic rows.
The fixture bundle is generated locally with no network or warehouse reads by
`node diagnostics/build-retention-sql-validation.js`. Tests assert its contents
exactly match the current factory/service. It includes full linked SELECT and
transaction-script SQL, not just an aggregation suffix.

A direct Google dry-run attempt here failed **HTTP 403: Could not refresh access
token: Domain forbidden**, before compilation. No BigQuery dry run, synthetic
execution, live transaction execution or live report success is claimed locally.
The BigQuery test remains opt-in/skipped in ordinary offline gates.

Browser acceptance passed 21 conversations at desktop/mobile, including durable
refresh and activated identity refresh. Full local acceptance passed **769 tests,
zero failures/cancellations/skips** (21 central conversations and 53 regression
suites). The five new tests are included in the required matrix. Offline gates do
not establish BigQuery validity.
Keep the PR draft pending the returned validation checks.

## One bounded Render validation command

Run at the deployed repository root. Uses deployed BigQuery/config/retentionRows;
the corrected SQL and runner are immutable and SHA-256 checked. All full linked
queries are **dry runs only**. Only table-free synthetic SELECTs execute, with
one fixture customer and three retention windows. Those results pass through the
existing strict application validator and explicit count/attribution assertions.
This is no automatic replay of the recovered or failed report.

The command emits each check independently. There are exactly 27 bounded checks:
nine full SELECT dry runs, nine script dry runs and nine synthetic executions.
BigQuery stops script dry runs after the first DDL; the separate complete SELECT
dry run checks the remaining expressions, but does not establish transaction
script execution, materialization behavior or production result correctness.
Synthetic execution does not exercise production identity tables/guard contents,
full upstream schemas or transaction materialization. No persistent destination,
source collection, publication, snapshot repair, identity change or production
transaction execution occurs. Ordinary warehouse job resources are allocated for
the synthetic SELECTs; no production data is written.

```sh
timeout --signal=TERM --kill-after=5s 210s node --input-type=module <<'JS'
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
const revision='887fbb212d894dd7eb7c7b21e7af2fd66c6148c4';
const base=`https://raw.githubusercontent.com/lmnopstudios-dot/tgf-bigquery-sync/${revision}/diagnostics/`;
async function pinned(name,hash,limit){
  const r=await fetch(base+name,{signal:AbortSignal.timeout(8000),redirect:'error'});
  if(!r.ok)throw Error('Pinned validation artifact unavailable');
  const chunks=[];let size=0;
  for await(const chunk of r.body){size+=chunk.length;if(size>limit)throw Error('Artifact size bound');chunks.push(chunk);}
  const b=Buffer.concat(chunks);
  if(createHash('sha256').update(b).digest('hex')!==hash)throw Error('Artifact hash mismatch');
  return b;
}
try{
  const [{BigQuery},{loadBigQueryConfig},{retentionRows},source,compressed]=await Promise.all([
    import('@google-cloud/bigquery'),import('./bigquery/client.js'),
    import('./oracle/cohort-retention.js'),
    pinned('validate-retention-generated-sql.js','3ff1ff9c7f19d803268b0bf51af4e24680349ca5a2d1073aa69da9ab7cd0bc9f',32768),
    pinned('retention-sql-validation.json.gz','410a6920c34d4b7bec1ea3c27f6489474646ccd3341140146e5d1213e10f2c6d',262144)
  ]);
  const artifact=JSON.parse(gunzipSync(compressed,{maxOutputLength:2097152}));
  const {project,credentials}=loadBigQueryConfig();
  if(project!==artifact.project)throw Error('Validation project mismatch');
  const {validateRetentionSql}=await import('data:text/javascript;base64,'+source.toString('base64'));
  const result=await validateRetentionSql({
    bigquery:new BigQuery({projectId:project,credentials,autoRetry:false,maxRetries:0}),
    artifact,validateRows:retentionRows,dateValue:v=>BigQuery.date(v),
    onCheck:check=>console.log(JSON.stringify({validation_revision:revision,...check}))
  });
  console.log(JSON.stringify({validation_revision:revision,...result}));
  process.exitCode=result.checks.some(c=>c.status==='failed')?1:0;
}catch(e){
  console.log(JSON.stringify({read_only:true,report_replayed:false,status:'validation_unavailable',message:String(e.message).slice(0,200)}));
  process.exitCode=1;
}
JS
```

Shared validation budget is 180 seconds, ten seconds per check. Full SELECT dry
runs carry the existing 20 GB ceiling, script dry runs the existing 2.5 GB per
statement ceiling; these do not execute or bill query processing. Synthetic
execution is capped at 100 MB per SELECT and returns three rows. Fetches are eight
seconds, 32 KiB runner / 256 KiB gzip, decompression at most 2 MiB. Process TERM
at 210 seconds, kill five seconds later. No original warehouse job is restarted.

Merge recommendation: hold until the full SELECT dry runs and synthetic execution
checks succeed, with any remaining script-dry-run/provider limitation explicit.
Even successful validation will not establish complete follow-up ingestion or
justify mature retention rates. The independent coverage-evidence gap remains.
