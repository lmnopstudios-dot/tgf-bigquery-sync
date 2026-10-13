# Shared order-value selection: investigation and acceptance

Request: `e41cdcdc-954d-43e8-ab59-43a15b4a1836`.

## Demonstrated cause and limits of incident attribution

GitHub reports PR #311 merged at 2026-10-13 08:28:22 UTC. The fetched latest
`origin/main`, `07f5331f91e17afabc2331999dc7957feebbb5dc`, contains it; this
branch starts at that merge. The feature, population SQL, numeric calculator,
XLSX validation and recovery were retained.

On that source revision, the exact production message resolves September dates
but **no subject, numeric operation or capability route**. The operation recognizer
requires the literal word `threshold` for scenarios. Natural free-shipping
comparisons without that word bypass the registered aggregate route. With retained
product/conversion/campaign context the missing operation recognition also permits
incompatible prior scope to survive. Once recognition is broadened, a second
defect appears: calendar refinement only recognizes particular refinement prefixes,
so a fresh `Assess ... for September 2026` scenario defaults to year-to-date.
Both defects are reproduced and fixed through shared semantic parsing.

Source inspection establishes the production bindings on latest main:
`server.js` constructs `orderValueService` through `createOracleProviderDependencies`,
passes it into `createBaselineOverviewService`, and uses that composed baseline
from `/agent` and the UI/durable dispatcher. The registry and executable route
include `get_order_value_analysis`. Existing evidence calculation/presentation is
deterministic. The general-agent model path is reached only when deterministic
selection does not return an answer. Its large synthesis input is consistent with
the supplied individual-order execution logs, but neither this source inspection
nor those logs identifies the revision/configuration that served the incident.

**Live revision and dependency bindings remain unverified.** The configured origin
is a usable HTTP URL, but bounded read-only revision requests failed. No Render
revision is exposed in this workspace. A bounded September stored-evidence
inspection failed with HTTP 403 `EGRESS_FORBIDDEN` before dataset/schema access.
No production counts, schema execution or shipping-policy correctness are claimed.
The runtime skill reports current observations but network/variable readiness as
unknown; a configured name alone does not establish working credentials/access.

The production logs establish validated individual-order reads, the 74,016 ms
`ORACLE_AGENT_DEADLINE`, and aborted round-2 synthesis (28,335 ms / 36,112 input
bytes). They do not establish a registry omission, missing binding, model decision
or stale deployment. The reproduced parser defects are demonstrated source causes,
not proof of which live cause served that request.

## Resulting shared mechanism

- Natural monetary shipping/order-value comparisons select the existing aggregate
  capability without requiring `threshold`. Comparison amounts and the hypothetical
  charge occupy separate parameters. The exact request resolves £250 baseline,
  £250/£200/£225 alternatives, £8 illustrative fee and September 1–30, 2026.
- Date extraction uses the shared natural period parser independently of the
  daily-sales refinement prefix. Explicit platform/channel qualifiers remain
  authoritative; Woo/POS populations receive a limitation instead of silently
  becoming Shopify online. New subjects clear incompatible prior scope.
- Capability contracts select delivery from the resolved execution plan. Missing
  country/currency receives interactive clarification; the answer and all four
  requested follow-ups retain the executable aggregate plan. Supported order-value
  plans prefer durable delivery, while explicit interactive submissions execute the
  same bounded calculation. No timeout has been increased.
- The production baseline composition honors resolved capability bindings before
  legacy message recognizers. A missing order-value execution binding returns a
  relevant limitation on direct and UI paths, with no individual-order fallback.
- Exact individual order questions clear incompatible retained aggregate context and
  preserve the existing bounded `getOrderDetails`/line-item service.
- Population and coverage still use two aggregate queries, not order-detail fan-out.
  Existing 366-day, 50,000-group and 1 GB/query limits remain. Waiting and SQL job
  duration now respect the request deadline, cancellation and a 45-second ceiling.
  Failed/timed-out optional coverage preserves successful population evidence;
  late results cannot be appended after the bound. Underlying SQL uses a server-side
  job timeout; this is not a promise that an in-flight SDK request is forcibly
  cancelled when the client aborts.
- Synthesis input becomes validated bands/scenarios/coverage/definitions through the
  existing deterministic presentation. Aggregate fixtures make zero model calls.
  Histogram evidence remains available for validation/recovery, with material
  unknown-value and incomplete-coverage information retained. No per-order payload
  is sent into model synthesis.
- New diagnostics contain selected route, registered/bound booleans, delivery,
  provider counts, aggregate group counts and synthesis path. They contain no
  order identifiers, customer data, prompts or raw provider payloads. The root
  revision response now inspects registry/provider/dispatcher bindings directly.

Recorded shipping is a known subtotal of original collected charges on affected
orders; missing charges are counted separately. The hypothetical £8 multiplication
is distinct and is not expected revenue or profit. Observed discounted presentment
subtotal is the named basis. Stored zero amounts/charges remain ambiguous unknowns.
Tax inclusion, actual shipping-rule eligibility, positive Online Store attribution
and complete source collection remain unverified as documented in
[the original evidence contract](order-value-scenarios.md).

Job lease ownership, checkpoints, recovery, generation isolation, artifact ownership,
checksums and request-ID idempotency retain their existing implementations. No
collection, backfill, inventory calls, source/knowledge writes, schedule changes,
deployment or merge were performed.

## Executed verification

The new tests invoke the real shared production provider factory and baseline
composition, with production-shaped aggregate fixtures at the BigQuery boundary.
They assert actual query options, UK/online/GBP predicates, dates, monetary basis,
fee, scenario alternatives, affected counts, recorded/hypothetical distinction,
unknown-value denominator, provider calls, no detail/model fallback, and no unrelated
inventory/product/sales recognizer calls for selected aggregate requests.

Coverage includes the exact prompt and two paraphrases; fresh and retained product,
conversion and campaign contexts; the direct entrypoint and HTTP bridge with
`governedAgentRequest`; authenticated interactive and durable submissions;
`Try £175`, `Just August`, `Show the bands`, `Export that`; clarification; missing
capability; unsupported populations; expired deadlines; optional coverage timeout;
owned XLSX and completed-job recovery; actual individual-order service calls.

Completed runs:

- Initial full repository run: 1,135 passed, zero failed, three opt-in live SQL
  checks skipped. Subsequent HTTP/unsupported-population/runtime-binding additions
  are covered by the final run below.
- Focused six-file conversation/clarification/context/dispatcher suite: 75 passed,
  zero failed. The later direct HTTP test is covered by the final full run.
- Actual offline browser UI/API/worker: desktop 1280×900 and mobile 390×844 passed
  compact tables, charts, closed details, all four follow-ups, owner-authenticated
  XLSX download, refresh recovery and page-overflow checks. Production factory and
  baseline composition are used; fixture boundaries prevent unrelated services.
- 46 strict schemas across 61 tools validated; server syntax and diff whitespace
  checks passed.
- Bounded live September diagnostic: blocked with `EGRESS_FORBIDDEN`; it did not
  return production evidence. Root deployment revision requests failed.

- Final full repository run: 1,138 passed, zero failed; three opt-in live SQL checks skipped (1,141 total). The new selection suite passed all 20 tests, including the direct HTTP bridge and unsupported-population checks.

## Bounded read-only Render acceptance

Run inside the existing Render service checkout using its configured environment.
These are acceptance commands for a checkout containing this change; they do not
instruct deployment, collection, enqueueing jobs, creating artifacts or merging.

```sh
# Establish which checkout/process is being inspected and that PR #311 is present.
printf '%s\n' "${RENDER_GIT_COMMIT:-unavailable}"
git rev-parse HEAD
git merge-base --is-ancestor 07f5331f91e17afabc2331999dc7957feebbb5dc HEAD

# Inspect real production factories and semantic selection, with zero provider reads.
timeout 15s node diagnostics/oracle-order-value-bindings.js

# Read existing September stored components only (two bounded aggregates + schema read).
timeout 90s node diagnostics/oracle-order-values.js --start 2026-09-01 --end 2026-09-30

# Read-only HTTP process revision/bindings; print only an allowlisted summary.
timeout 15s node --input-type=module - <<'JS'
const response=await fetch(new URL('/',process.env.ORACLE_UI_ORIGIN),{signal:AbortSignal.timeout(10000)});
if(!response.ok)throw new Error('Revision endpoint unavailable');
const data=await response.json();
console.log(JSON.stringify({revision:data.revision||null,order_values:data.oracle_capabilities?.order_values||null}));
JS
```

If the root process revision differs from the checkout, investigate that difference
before attributing the incident. Before this fix is deployed, the root endpoint may
not expose the new binding summary; absence of that summary is not proof of a
missing provider. Compare the live revision's `server.js`, factory, registry and
baseline composition. No revision or binding check should submit the production
prompt to an old general agent, because it could recreate the detail-fetch loop.

Remaining live checks: establish the incident/current process revision and PR #311
ancestry; confirm executable bindings in that revision; execute bounded SQL in its
actual dataset location; validate stored fields, coverage/unknown counts and shipping
policy independently. Production browser delivery is not claimed by the offline
browser run. It can be checked after an independently authorized deployment, without
collection/backfill/knowledge mutation, using the existing owner/job recovery flow.
