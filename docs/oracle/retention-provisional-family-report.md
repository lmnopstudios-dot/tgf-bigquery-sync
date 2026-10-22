# Provisional observed retention and governed product families

The supplied business report is successful request
**e1f1d7b0-6dcf-40e5-8f82-76637e354b0b**. It has aggregate observed repeats and
unverified follow-up, but lacks the customer-level age-qualified numerator and
denominator needed for provisional rates. Neither pasted attachment supplies
those missing aggregates. This change does not alter or replay that saved job,
invent rates from its totals, collect data or modify production data.

Scope remains entry 2022-10-19 through 2026-10-19, cutoff 2026-10-19,
Europe/London; configured email_candidate_v2 identity at
customer_identity/history-20261022-billing-v3. Identity guards, linked sequencing,
import/cancellation/refund exclusions, governed classifications and independently
successful report components remain intact.

## Calculation contract

For each customer/cohort and each 90/180/360-day window:

- Provisional eligibility: `DATE_ADD(DATE(entry_timestamp, time_zone), INTERVAL
  window_days DAY) <= observation_end`. The entry's London calendar date, not its
  elapsed timestamp age or coverage certificate, determines age eligibility.
- Provisional numerator: those eligible customers whose first strictly later
  eligible order is observed within that same calendar-day window and cutoff.
- Provisional rate: numerator / eligible denominator, or unavailable if zero.
  Recent observed returners remain in the existing all-entry observed-repeat
  total, but enter neither provisional numerator nor provisional denominator.
- Verified mature denominator, verified repeat count/rate and conditional median
  retain their existing evidence-backed continuous-coverage rules. They remain
  zero/unavailable internally/rendered as unverified where certification is absent.

The two SQL aggregate factories use the same provisional eligibility and totals
helpers: named collaborations, individual first-purchase families/items, whole-
range product rankings, sitewide totals and calendar-year sitewide cohorts.
The aggregate fields are `provisional_eligible_customers`,
`provisional_repeat_customers`, `provisional_repeat_rate`. Strict normalization
and final delivery validation reject invalid bounds, inconsistent ratios, verified
counts exceeding the provisional subset, growing age-eligible denominators across
windows, and inconsistent calendar-year partitions. No provisional fields in
legacy retained evidence means **not calculated**, never a rate inferred from
all-entry customer/repeat totals.

Provisional estimates have uncertain prior history and follow-up, including
migration limitations. First-observed is not established first-ever; linkage is
analytical, not verified people. Missing transactions can lower observed repeats,
and incomplete history can misclassify entries. This is an association, not a
causal effect or certified company-wide ranking. Small denominators stay visible.
Provisional reporting does not certify coverage from an email checkpoint or
resolve the independent transaction-completeness evidence gap.

A synthetic regression illustrates why the old totals cannot be used: three
entry customers, including a recent returner, have two observed 90-day returns;
only two entries are 90 days old, and only one of those returns. The provisional
rate is **1/2**, not 2/3 or 2/2. These are test inputs, not figures for the saved
business report. Boundary tests cover exactly 90, 180 and 360 London calendar
days, including timestamps straddling UTC midnight during British Summer Time.

## Reporting families, not inferred identity

Use the existing resolved active family decisions and approved reporting-family
routes in the classification reader. Include the governed parent itself. A source
with exactly one approved target receives `family:<governed parent reference>`;
multiple targets retain its source reference with `ambiguous_family`. No family
route retains the source item with `unmapped_item`. Approved identity alone does
not invent a reporting family. Titles are never stripped/matched to infer membership.
Labels come from existing reviewed parent titles, with an explicit unavailable-
title fallback. Reporting keys do not become canonical product/customer identities.

Family grouping happens before customer counts, not by summing variant rows:

- Named/item membership groups by customer, collaboration and reporting family.
- Whole-range membership groups by customer and reporting family.
- Second-order products use COUNT(DISTINCT customer) per reporting family within
  the cohort/window, so two sizes on one order count that customer once.

Original source-product classification and coverage diagnostics remain separate.
Conflicting/missing product identities retain unknown attribution. Unmapped items
and ambiguous families stay explicit. Cohorts for different families or named
collaborations can overlap and must not be added. Family status is retained in
structured evidence. Older product rows without family evidence are labelled as
such rather than retrospectively declared mapped/unmapped.

## Business view and full results

The main report shows provisional collaboration comparisons and comparable
sitewide totals first, including numerator, denominator and rate at each window.
Whole-range family/item rankings and second-order highlights follow. Unknown
attribution and software/component failures remain explicit. Identity and the
necessary provisional-history/follow-up/migration disclosure remain visible.

One expandable **Full results, verified-coverage rates, reconciliation and
caveats** section retains all original tables and diagnostics, full individual
item/family tables, sitewide yearly cohorts, known/unknown second-order evidence,
source-specific collection reconciliation and reviewed display names. It avoids
nested details because the client's safe Markdown renderer supports a single
expandable body. Structured evidence retains every returned row; refresh does
not rerun providers. Existing stored answers are not rewritten by this source fix.

Whole-range rankings keep separate age-qualified repeat-count, provisional-rate
and verified-rate ranks. Up to ten products per each of three rankings requires
at most 90 rows per source (30 products times three windows), 270 across sources.
The existing independent named/item/baseline quotas remain unchanged. Main-view
highlights do not remove rows from the full retained evidence. Bounds and partial
results remain explicit.

## Verification status

Ten focused tests execute actual generated aggregate/family SQL through an
explicit local SQLite dialect adapter and test validation/rendering. They cover
recent returners, zero denominators, all London calendar-age boundaries, annual
partitions, duplicate size lines, second-order distinct-customer counts,
unmapped/ambiguous families, no title inference, ratio tampering, all nine linked
query shapes and access to full results. This is not BigQuery compilation.
Existing direct, interactive and durable fixture tests assert the verified rate
stays unavailable while provisional estimates are present and reject a tampered
provisional rate at final delivery. Browser tests check summary/full-results
visibility, legacy results and refresh without provider replay. Required gate
results are recorded in the PR after completion.

A fresh BigQuery dry-run attempt is blocked **before compilation** by OAuth 403:
`Could not refresh access token: Domain forbidden`. Corrected SQL execution,
production provisional figures and report performance have not been verified
here. The opt-in generated-BigQuery test now checks the provisional fields across
all nine shapes and both synthetic coverage modes. The synthetic verified interval
certifies no production data. Production execution limits have not increased.

## Optional bounded SQL validation in Render

This does not submit/replay a business report. It dry-runs full linked SELECTs and
limited transaction scripts, and executes table-free synthetic SELECTs only.
Artifact generation uses the actual proposed service/factory SQL from main
0e1e6c00cda26183ab8bab581be74a7255cff4ae plus the proposed fix, with exact
artifact-equality regressions. The deployed strict row validator is extended by
the pinned new provisional/family-field validators so this also works before the
new server code is deployed. Current source tests use the complete new validator.

```sh
timeout --signal=TERM --kill-after=5s 850s node --input-type=module <<'JS'
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
const revision='1defa15fbcaed5924210b5acd728240b2ce66286';
const base=`https://raw.githubusercontent.com/lmnopstudios-dot/tgf-bigquery-sync/${revision}/`;
async function pinned(path,hash,limit){
  const r=await fetch(base+path,{signal:AbortSignal.timeout(8000),redirect:'error'});
  if(!r.ok)throw Error('Pinned validation artifact unavailable');
  const chunks=[];let size=0;
  for await(const chunk of r.body){size+=chunk.length;if(size>limit)throw Error('Artifact size bound');chunks.push(chunk);}
  const b=Buffer.concat(chunks);
  if(createHash('sha256').update(b).digest('hex')!==hash)throw Error('Artifact hash mismatch');
  return b;
}
const moduleFrom=b=>import('data:text/javascript;base64,'+b.toString('base64'));
try{
  const [{BigQuery},{loadBigQueryConfig},{retentionRows},runner,fields,compressed]=await Promise.all([
    import('@google-cloud/bigquery'),import('./bigquery/client.js'),import('./oracle/cohort-retention.js'),
    pinned('diagnostics/validate-retention-generated-sql.js','206fddca2f7c63a96b87ce8760e4ebc64e99c50e6927595a3e9f9a7c56541504',32768),
    pinned('oracle/retention-provisional.js','9a19dd6f31891c5044e94639742d64cab08a89d927b55cb5b3b436f6eb362793',32768),
    pinned('diagnostics/retention-sql-validation.json.gz','03ec21fc90091a77cdad480f74863c28299a83a127434a32da53e6bd8a1ae5fc',262144)
  ]);
  const artifact=JSON.parse(gunzipSync(compressed,{maxOutputLength:2097152}));
  const {project,credentials}=loadBigQueryConfig();
  if(project!==artifact.project||process.env.ORACLE_CUSTOMER_IDENTITY_MODE!=='email_candidate_v2'||
     process.env.ORACLE_CUSTOMER_IDENTITY_DATASET!=='customer_identity'||
     process.env.ORACLE_CUSTOMER_IDENTITY_SNAPSHOT!==artifact.snapshot)throw Error('Existing configuration does not match requested scope');
  const [{validateRetentionSql},{provisionalEvidence,familyEvidence}]=await Promise.all([moduleFrom(runner),moduleFrom(fields)]);
  const result=await validateRetentionSql({
    bigquery:new BigQuery({projectId:project,credentials,autoRetry:false,maxRetries:0}),artifact,
    validateRows:rows=>rows.map(row=>({...retentionRows([row])[0],...provisionalEvidence(row),...familyEvidence(row)})),
    dateValue:v=>BigQuery.date(v),onCheck:check=>console.log(JSON.stringify({validation_revision:revision,...check}))
  });
  console.log(JSON.stringify({validation_revision:revision,...result}));
  process.exitCode=result.checks.some(c=>c.status==='failed')?1:0;
}catch(e){console.log(JSON.stringify({read_only:true,report_replayed:false,status:'validation_unavailable',message:String(e.message).slice(0,200)}));process.exitCode=1;}
JS
```

Thirty-six independent checks; ten seconds per synthetic/script check, 60 seconds
per full SELECT dry run, 810-second shared bound. Limited script dry runs stop
at the first DDL and never establish complete script execution. Full SELECT dry
runs establish compilation only; synthetic SELECTs establish calculation/result
validation only. No production transactions execute. Fetches are eight seconds,
32 KiB per code module/256 KiB gzip, decompression at most 2 MiB. Normal query-job
metadata is allocated; no persistent data destinations, collection/publication,
identity/classification changes or writes occur. No command here replays e1f1d7b0.

Merge/release recommendation: keep draft pending corrected BigQuery validation.
After an independently authorized release, a deliberately requested calculation
against the same existing warehouse/snapshot can populate the new age-qualified
fields. It does not require recollection or coverage certification, but it cannot
be replaced by arithmetic on the saved aggregate report. No automatic replay,
merge or deployment is included in this PR.
