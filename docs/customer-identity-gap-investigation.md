# Bounded relationship and email investigation — 2026-10-20

Follow-up: [Metorik-first identity completion](metorik-identity-completion.md)
records the operator's resolved live samples, demonstrated collector email
omissions, separate ID semantics, retained-evidence design and remaining blockers.
Do not interpret this older run's unavailable samples as upstream email absence.

Production figures supplied by the operator (not remeasured here): WW 24,462
selected orders; USD 3,734; Shopify 14,102 relationships selected. Three sampled
Woo orders/source had no usable emails. Shopify had 3/3 usable order/customer
emails and required scopes. Its parent check found 14,967 distinct orders,
865 missing relationship rows (5.78%), zero duplicates and zero invalid customer
IDs. Neither the 865 rows nor the Woo samples have been classified live here.

The managed executor's configured proxy is unreachable. All three diagnostic
warehouse selections failed before source sampling. These failures establish no
customerlessness, redaction, extraction failure or upstream email availability.
GitHub connector reads did work: the changes start from main
`939fbcbdd7a2ac05d5791a000d3fe1c7383dac01`, preserving merged PRs #349–#352.

## Read-only commands on the production executor

Run each once from the reviewed checkout with its existing protected credentials:

```sh
timeout --signal=TERM --kill-after=3s 120s node diagnostics/customer-identity-gaps.js --source=shopify
timeout --signal=TERM --kill-after=3s 260s node diagnostics/customer-identity-gaps.js --source=ww
timeout --signal=TERM --kill-after=3s 260s node diagnostics/customer-identity-gaps.js --source=usd
```

The default inclusive window is 2022-09-24–2026-10-19. No apply mode, data writes,
run markers, activation or enrichment are available in this diagnostic. Each
warehouse query has the existing 1 GB/20 s bound and DATE SDK serialization.
No emails, source IDs, payloads or provider messages are printed or persisted.

Shopify reads exact missing parent order IDs, with a 1,001-row overflow sentinel
and hard 1,000-order cap. It queries nodes in batches of 50, at most 24 HTTP
requests including token acquisition, 90 s source deadline, 2 MiB/response and
32 MiB decoded JSON in total. The reported 865 gaps need 18 node requests plus
authentication. Explicit `customer:null`, valid attached customer GIDs, unavailable
orders, omitted/invalid fields and request failures are separate counts. A
GraphQL batch error remains a request failure and never becomes a guest count.
Only a fully resolved run can classify every missing row.

Woo selects two distinct orders per calendar quarter and warehouse guest/
registered stratum, at most 80 orders/source (81-row overflow sentinel), ordered
deterministically across the full window. The chosen window has at most 68
nonempty sample slots/source. Sampling reads retained Metorik order payloads;
WW additionally reads `woocommerce_uk.orders_api` for those exact order IDs, capped
at 800 raw rows plus an overflow sentinel. Unavailable/incompatible raw storage
is reported separately. USD's additional native raw relation is unverified and
is not guessed. At most 160 API requests/source, 180 s source deadline, 2 MiB/
response and 32 MiB total decoded API JSON. Registered customer lookups use only
the native API order's customer ID, never a Metorik customer ID.

Output reports sampled strata and separate counts for explicit null, empty,
placeholder, malformed and usable values; omitted/invalid fields are extraction
failures, and failed order/customer reads are unavailable. Retained usable email
is compared with API values in memory. Unavailable API orders are outside the
email-field comparison denominator; the retained-usable count includes them.
Sampling is purposive, not a population estimate, and cannot establish redaction.
An absent warehouse stratum is not a tested native guest/registered population.

## Concrete conditional repair and enrichment scope

The normal Shopify collector maps **every** returned order to a relationship row,
including `customer_id:null,is_guest:true`. Thus legitimate customerlessness does
not explain why the relationship row is missing. The source lookup distinguishes
which missing rows should contain a customer GID and which should explicitly
contain null; it cannot reconstruct the historical collector failure cause.

Prepare a missing-only `order_id` MERGE using exact successfully resolved gaps.
Re-read required eligibility fields (`createdAt`, `updatedAt`, financial status,
cancellation and app) for the same IDs before staging. Preserve explicit null
customers; create no customer records. Use an expiring private stage, validate
unique IDs and exact parent membership, and insert only rows still absent at
commit time. Existing relationships, source tables, finances and scheduled
refresh watermarks stay untouched. Recheck all four relationship aggregates
afterward. Unavailable/omitted/error cases remain unresolved and block complete
enrichment. No repair is authorized by an unverified candidate count alone.

The existing `shopify/customer-recovery.js` is not the exact repair for this
population: it selects GBP `order_financials` gaps, caps at 500 IDs, updates matched
rows and advances the refresh watermark. Do not expand its cap or run a broad
repair to force the 865-parent-row discrepancy to disappear.

Woo full enrichment remains deferred for both 24,462 WW and 3,734 USD selected
orders. First review the bounded comparison. Future enrichment must retain
usable raw warehouse evidence alongside API evidence, preserve disagreements for
ambiguity checks, and keep native source/customer provenance. The diagnostic
does not import retained Metorik/raw evidence into `order_identity`. That import's
scope and schema need the live results; do not infer complete identity evidence
from a null API response or declare unavailable customers resolved.

One demonstrated writer defect is repaired now: a newer null/empty API value
could replace usable stored Woo email evidence. The MERGE now retains each usable
stored raw/normalized pair when the incoming value is missing, recomputes conflict
state from the effective pair, and refuses to carry a previous customer's email
to a changed customer ID. Shopify behavior and the source raw tables are unchanged.
Re-running the same evidence produces the same email values. This protects
already stored usable Woo evidence; it is not a substitute for reviewing and
incorporating retained native raw evidence before full enrichment.

Validation: 20 identity, diagnostic, real SQL-expression and SDK preflight tests
pass, including the prior merged DATE regression. Fixture success is not live
production verification. An additional existing activation suite passed nine
tests; two SQL fixture tests timed out in this executor's Python stdin subprocess
transport. The new SQL tests and preflight regression use argv fixture input to
avoid that environment limitation. No production data, enrichment or activation
was changed.
