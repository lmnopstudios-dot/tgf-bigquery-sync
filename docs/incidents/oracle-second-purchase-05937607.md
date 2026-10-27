# Saved second-purchase evidence rejected during polling

Request `05937607-7e9a-468c-804c-c53e2d05026a`; durable job
`c791e053-9a69-4f12-b2c4-23801932d710`; warehouse job
`09eca6ed-5734-41c2-9dec-d9e72307663b`.

## Saved evidence and exact mismatch

The operator's bounded read of the existing job returned `status=completed`,
`error_code=null`, the saved partial answer and its scope/validation summary.
This environment's direct lookup was blocked by egress; the supplied saved-job
output is the evidence source. No report replay or job update was performed.

The requested context and saved result context agree. Both the contract and
calculation definition compare semantically equal to their expected values, but
both compare unequal under `JSON.stringify`. Stored JSON object members were
reordered. The saved row validator passes for all 100 cohort/window rows.
Completeness reports only `product_journey_contract` as missing, with
`Product journey evidence scope mismatch` from the shared evidence assertion.

`assertProductJourneyEvidence` compared the contract and definition by serialized
text. The worker validated the original objects, but the same strict text check
rejected the JSON-hydrated equivalents during `job_status_lookup`.
`assertAnswerCompleteness` at line 134 is the aggregate rejection point, not a
failed customer count or calculation. This is a delivery/persistence defect.
The saved fixture commits only scope and validation metadata; no production rows
are reconstructed from the answer or fabricated for a test.

## What is partial

Both section outcomes are fulfilled: `overall` and `journeys`. The 100 rows are
four overall windows, 20 main entry-product cohorts × four windows and four
separately ranked Ring Sizer cohorts × four windows. No section was rejected.

The saved answer's primary overall population is 26,255 entry customers and
4,861 observed second-purchase customers. Its limitations are explicit:

- Observed next-order and age-qualified window rates are provisional;
  continuously verified follow-up rates are unavailable.
- The overall next-order attribution has 115 returners without lines and 40
  with unidentified products; flags may overlap. Unknown entry attribution
  affects 952 customers and is retained in the overall population.
- Main products are limited to the requested top 20 out of 920 observed overall
  next-order products; first-product selection is top 20 out of 1,313 main entry
  products. Destination lists use their requested per-cohort limits. Those
  stated ranking bounds do not represent failed sections.
- Some age-qualified denominators are zero and some cohorts are small.

The producer marks the report partial for these observed/provisional semantics;
recovery must preserve that status and those limitations, not claim verified
coverage or manufacture missing values.

## Fix and safeguards

The shared evidence assertion now compares the two objects with Node's
`isDeepStrictEqual`. It ignores object-member insertion order while requiring
identical keys and values, including nested fields, types and ordered arrays.
No expected field is omitted or normalized away. Dates, population, identity,
limits, rankings, windows, denominator semantics and row validation remain strict.

No calculation, provider arguments, linkage, approved mapping, eligibility,
completeness requirements, saved answer or persisted job is rewritten. Existing
saved evidence becomes compatible with polling after this code is deployed;
there is no migration, requeue, provider replay or result repair operation.

## Regression and verification

The saved scope metadata proves the prior text inequality and semantic equality.
Regression cases then use explicitly synthetic evidence rows. A job-store SQL
transport double models reordered JSON object members while leaving array order
intact. The real production store owns serialization/hydration, lease handling
and completion. Durable HTTP execution, owned polling and latest-result recovery
retain the partial answer and evidence without additional provider reads.

Negative cases still reject actual scope mutations, omitted/extra fields,
reordered window arrays, wrong product denominators and missing result windows.
Independent section-rejection cases retain only the valid section. Browser checks
now use reordered warehouse JSON for the second-purchase fixture and verify
visible desktop/mobile tables and refresh recovery without another evidence read.
The established collaboration report remains in both release gates.

A local validation of the preserved Render snapshot, from a checkout of this fix,
can check the exact saved evidence without querying or updating anything:

```bash
node --input-type=module <<'NODE'
import fs from 'node:fs';
import {assertEvidenceAgreement} from './oracle/analysis-route-dispatcher.js';
import {answerCompleteness} from './oracle/answer-completeness.js';
const {requested,result}=JSON.parse(fs.readFileSync('/tmp/oracle-c791e053-saved-result.json','utf8'));
const context=result.analysis_context||requested;
assertEvidenceAgreement(context,result.evidence);
console.log(JSON.stringify(answerCompleteness(context,result)));
NODE
```

Expected: partial status with an empty `missing` list. This command reads only
the existing local snapshot and does not replay the report or modify the job.

Final local verification: all 878 acceptance tests passed; the desktop/mobile
browser gate passed, including canonical JSON persistence and refresh recovery.
The focused product/persistence run passed 13 tests; the final persistence suite
passed all five cases. These are local provider/transport fixtures, not a live
poll of the production job. The original saved job and warehouse results remain
untouched. No production replay, merge or deployment was performed.
