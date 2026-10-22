# Collaboration retention reconciliation, 22 October 2026

Scope is frozen at entry 2022-10-19–2026-10-19, observation cutoff
2026-10-19, Europe/London. The supplied recovered report uses activated
email_candidate_v2 with snapshot customer_identity/history-20261022-billing-v3.
The report has not been replayed. This document distinguishes supplied observations,
source defects, and unresolved production evidence. It is not a completed live report.

## Supplied governed catalogue against the displayed report

The starting population is the supplied governance catalogue: 25 collections,
including generic Collaborations (657279516999, 122 products, `collaborations`)
and 24 named entries. These are evidence for this incident, not an executable
cohort allowlist. The reader resolves current governance decisions dynamically.

| Reviewed collection | Shopify collection ID | Products | Displayed reconciliation |
|---|---|---:|---|
| Sammi | 657944510791 | 21 | Absent; precise cause unverified |
| P&CO | 690153193799 | 8 | Absent; precise cause unverified |
| END. | 661263089991 | 7 | Included as End |
| Rolling Stones | 657967546695 | 7 | Included |
| Harley Davidson | 657279582535 | 6 | Included |
| Motörhead | 657969971527 | 5 | Included as Mot Rhead |
| Ārdēo Studios | 657938972999 | 4 | Included as Rd O Studios |
| Dark Arts Coffee | 658364334407 | 4 | Absent; precise cause unverified |
| Elfin | 658066014535 | 4 | Included |
| Iron Maiden | 658016338247 | 4 | Included |
| Dr. Martens | 658350702919 | 2 | Included as Dr Martens |
| Emily Malice | 658346180935 | 2 | Included |
| Ghost | 658058248519 | 2 | Included |
| Good Charlotte | 675704734023 | 2 | Included |
| Judas Priest | 658015322439 | 2 | Included |
| Ozzy Osbourne | 659656573255 | 2 | Absent; precise cause unverified |
| Death Spray | 658147934535 | 1 | Included |
| DicE | 658346246471 | 1 | Absent; precise cause unverified |
| Mooneyes | 658005721415 | 1 | Absent; precise cause unverified |
| Royal Enfield | 657966924103 | 1 | Absent; precise cause unverified |
| Slayer | 658349228359 | 1 | Absent; precise cause unverified |
| TGF X 4Q | 657939923271 | 1 | Absent; precise cause unverified |
| TGF x Cut Rate | 657939759431 | 1 | Absent; precise cause unverified |
| TGF x Emily Malice | 657939530055 | 0 | No current products |

There are 13 included named entries, ten absent positive-product entries and one
zero-product entry. Emily Malice and TGF x Emily Malice have **different** governed
values (`emily_malice`, `tgf_x_emily_malice`). The supplied catalogue establishes no
alias decision joining them. Neither spelling similarity nor product identity
mapping merges collection classifications.

The successful supplied production diagnostic now resolves the ten absences by
source. All thirty observed eligible counts are zero **in that bounded read**;
missing mappings/history do not establish zero eligible customers.

| Collection | Shopify evidence | Woo WW / Woo USD evidence |
|---|---|---|
| Sammi | 14 historical named products; no observed eligible first-purchase matches | 2 / 1 historical named products; no observed eligible first-purchase matches |
| TGF x Cut Rate | Historical named products; no observed eligible matches | No governed historical source routes; eligibility unknown |
| Royal Enfield | Historical named products; no observed eligible matches | No governed historical source routes; eligibility unknown |
| Slayer | Historical named products; no observed eligible matches | No governed historical source routes; eligibility unknown |
| Ozzy Osbourne | Historical named products; no observed eligible matches | No governed historical source routes; eligibility unknown |
| TGF X 4Q | Current members/routes, no historical routed/named products; cause unverified | No governed historical source routes; eligibility unknown |
| Mooneyes | Current members/routes, no historical routed/named products; cause unverified | No governed historical source routes; eligibility unknown |
| DicE | Current members/routes, no historical routed/named products; cause unverified | No governed historical source routes; eligibility unknown |
| Dark Arts Coffee | Current members/routes, no historical routed/named products; cause unverified | No governed historical source routes; eligibility unknown |
| P&CO | Current members/routes, no historical routed/named products; cause unverified | No governed historical source routes; eligibility unknown |

None of these ten has a positive eligible count establishing truncation. The
independent quota defect below is verified in source, but is not the demonstrated
cause of these ten absences. The dynamic report now returns route/member/history
counts outside item and ranking limits, keeps observed matches separate, and
renders eligibility as unknown where mapping/history evidence is missing.
Historical classification conflicts/absence and missing catalogue membership have
separate statuses. No classifications or routes are inferred or written.

## Verified source defects and focused changes

The old report path shared a 200-row allowance across sources and groups. Requesting
baselines reduced each named/item read to 33 rows. Three-window cohorts reduced this
to eleven Shopify cohorts; an additional Woo two-store divisor reduced each
already store-specific Woo read to five. That matches the supplied five WW named
rows, eleven Shopify named rows and five/five/eleven unnamed item rows. The USD
named read returned three. Reaching these bounds cannot establish zero for omitted
collections. WW displayed named cohorts sum to 261 customers against 282 named
first customers; Shopify displayed named cohorts sum to 263 against 560. Even
allowing overlapping cohorts, the retrieved named tables do not cover the full
reported named populations.

Named reads now reserve 99 rows (33 complete window triples) per source; nested item reads
reserve 99, and sitewide reads three. Nested item selection takes one item from
each named collaboration before additional pieces, with unnamed membership in a
separate bucket. The combined main evidence cap is 600 rows,
independent of catalogue reconciliation and the nine sitewide rows. A single-store
Woo read no longer divides its cohort quota between two stores. Multi-store shared
reads still divide their budget. An exact full page alone is not labelled truncated;
SQL's count of the unbounded cohort population supplies that flag.

Reviewed collection titles accompany governed tokens; rendering preserves Motörhead,
Ārdēo Studios, END., Dr. Martens and other reviewed spellings without adding token
exceptions. Collections sharing exactly the same active governed name are displayed
as such; distinct governed names remain separate.

The diagnostic's LEFT JOIN assigned `product_identity_unmatched` both to missing
product identifiers and to orders with **no line evidence**. COUNT(l.order_ref)
contributed zero lines for the latter while COUNT(DISTINCT customer) increased.
The supplied 219 rows / 949 customers therefore cannot be interpreted as 949
customers represented by 219 product rows. It implies at least 730 customers with
no first-order line evidence; the exact split requires the retained aggregate rows
or a permitted future read. The new `order_lines_absent` state reports these
customers separately. Legacy saved aggregates whose customer count exceeds the
row count are explicitly labelled as a combined identifier/line-evidence diagnostic;
rendering does not invent a split or replay the saved population. Other states label the existing deduplicated grain as
**grouped order-product rows**, rather than claiming physical product-line counts.
An executed SQLite regression independently reproduces 219 missing-ID rows plus
730 no-line customers; those synthetic numbers demonstrate the mechanism, not a
certified production split.

## Coverage evidence and consumption

Source factory defaults still provide no observation certificates. Collection
progress, ready identity markers, original-order rosters, mapping counts, matched
billing emails and supplied source activity endpoints are not continuous transaction
coverage certificates. The supplied report gives WW endpoints 2021-03-25–2025-11-20,
USD 2022-04-02–2025-11-19 and Shopify 2025-11-16–2026-10-19. Those endpoints
establish observed activity only.

There is also a real consumption defect: the activated identity path explicitly
passed an empty certificate array, discarding even independently supplied valid
transaction certificates. It now validates all three source/store certificates
and consumes their common interval. A single entry-source certificate cannot
certify linked returns through other sources. Maturity at 90/180/360 days still
requires the entire calendar window within that interval and the frozen cutoff.
Missing certificates, timezone mismatch or disjoint intervals leave rates unavailable.
No deployment setting or certificate is written by this change.

The exact missing fact is independently evidenced continuous completeness of
eligible **original transactions** for each source/store/channel over the proposed
follow-up intervals, including gaps and retirement/handoff boundaries. To establish
it, retained transaction-ingestion evidence must identify:

- Source, store, channels, extraction filters, interval and Europe/London calendar
  boundaries, with immutable run/manifest references.
- Exhausted pagination/cursors and reconciled source-to-warehouse order keys/counts
  for that interval, including late arrivals and any outages/backfills.
- Cancellation/refund state completeness through the cutoff, original order dates
  and migration/import exclusions, consistent with report eligibility.
- Evidenced source retirement and migration handoff continuity, where relevant;
  last activity and public launch dates do not certify an absence of transactions.

Existing transaction ETL manifests, source reconciliations and lifecycle records
could supply these facts if retained. The **bounded search** inspected five datasets
(commerce, customer_identity, metorik_uk, metorik_us, shopify_data) for coverage/history
candidates; its inventory was not truncated. It found history_progress and
identity_snapshots, with eight complete adapter progress records and the existing
ready snapshot (58,465 mappings; technical range 1900-01-01–2026-10-19).
history_progress contains job/source/adapter/revision/cursor/complete/updated_at;
it can supply run lineage and adapter completion, not source transaction
reconciliation or certified continuous intervals. An identity roster derived from
warehouse orders cannot establish upstream ingestion completeness. A ready email
snapshot and its technical dates certify neither transaction follow-up nor first-ever
history. No inspected record supplies the missing certification. This bounded
result does **not** establish that no suitable evidence exists elsewhere.

**Blocker:** 90/180/360-day mature denominators and rates remain unverified until
those source-specific transaction facts are supplied and validated. Observed
repeat counts remain usable separately; unavailable rates are not zero retention.
Prior-history completeness is an independent uncertainty. No certificate, setting,
collection or snapshot is changed by this PR.

## Shopify failure and remaining requested sections

The supplied successful read-only production diagnostic retrieved the retained
outcome for request cda4261c-436a-4c99-89fc-36216381d87b, job
326dd52c-f3b4-4ade-a86e-0b53e58eb7a5. Query
**6026f7a6-44c6-4449-9814-398b028296f1 completed in BigQuery** (DONE,
failure null). The application rejected its evidence at evidence_validation with
EVIDENCE_SCOPE_MISMATCH. This was not a warehouse/SQL execution failure.

Sitewide calls now explicitly clear collaboration/product entry filters while
preserving identity, source, dates, channels, eligibility and coverage safeguards.
Completed reads retain query ID and activated identity evidence even if validation
rejects a component; bounded machine validation reasons distinguish source,
grouping, baseline and denominator contracts. Rendering distinguishes completed
warehouse reads with rejected evidence from retrieval failures.

A demonstrable shared SQL defect allowed missing second-order product IDs or titles
to invalidate an otherwise usable retention aggregate. Detail arrays now include
only known IDs, provide an explicit unavailable-title label for known products,
and separately count repeat customers with absent lines, unidentified products or
missing titles. No customer, cohort denominator or observed repeat is removed.
Invalid supplemental period/ranking evidence is isolated from validated parent
baseline/items and from other sources; strict denominator/source checks remain.

The subsequent successful exact-result diagnostic now confirms the rejected field:
**results[0].second_order_products[0].product_ref = null**. The shared boundary
keeps unidentified attribution separate from valid baseline metrics and strictly
rejects malformed identities in named detail. The exact regression preserves
8,897 baseline customers and 510/656/702 observed repeats; mature rates remain
unverified. See [confirmed baseline, finance failures and completeness verification](retention-confirmed-baseline-and-finance.md)
for supplied evidence and the separate production-error access blocker. No report
was replayed. Corrected live execution has not been claimed.

The existing named/item, whole-range sitewide and second-order product calculations
remain present. Their source/window/identity/eligibility contracts and independent
partial outcomes remain covered by existing report and browser suites. Enlarged
named/item quotas address omitted items but remain bounded. The source now also calculates
sitewide cohorts by London entry calendar year (first and last years remain partial)
and independent whole-range first-order product rankings, including products without
a collaboration classification. Rankings use observed repeat count and verified
mature repeat rate separately, with deterministic ties and up to ten products per
ranking. Unknown product identifiers are excluded from named product rankings.
They use the same entry orders, strictly later eligible order and certificates as
the main report, within the existing transactional read and budgets. No additional
provider query is made. Calendar periods are independently bounded at 150 rows per
source; ranking unions at 60 rows per source. The period counts reconcile to the
whole-range baseline. These source sections pass fixture and local SQL calculation
tests; no new production counts are claimed. Production scope validation and live transaction coverage certification remain
open before the business report can be considered complete. The supplied
source-specific reconciliation is recorded above; no live counts are recomputed.

## Verification

The regression suite is registered in the persistent acceptance matrix. It covers
catalogue growth and every reconciliation status, governed alias separation,
reviewed Unicode labels, independent quotas across sources, linked coverage
consumption through production composition, separate missing-line aggregation and
transactional SQL generation for the Shopify baseline, fair per-collaboration item
selection, executed calendar-period/product aggregation, whole-range unclassified
product inclusion, and supplemental section recovery. Existing report tests cover
90/180/360-day items, baselines, second-order products, partial failures and recovery.
Desktop/mobile browser coverage additionally checks reviewed labels and catalogue
reconciliation after refresh without provider replay. Local SQL adaptation and
fixture providers do not certify BigQuery schema or production results.

Required local gates: acceptance **764 passed**, zero failed/cancelled/skipped;
browser **passed**, 21 conversations at desktop/mobile widths with durable and
activated-identity refresh. Earlier focused SQL/report/coverage checks: 41 passed. The confirmed-null boundary
adds five regressions; see the latest confirmed-baseline findings for sequential
acceptance invocation and unrelated concurrent timing failures.
These gates do not establish corrected production counts or coverage.

No collection, republication, repair,
classification write, identity-setting change, IAM change, deployment or merge is
part of this change.

## Targeted unresolved-evidence handoff

The [single bounded read-only Render command](retention-unresolved-render.md) is
retained in the PR for auditability; **do not rerun it for these supplied results**.
The user supplied its successful output: eleven SELECTs and six metadata GETs,
with independent checks preserved. The normalized aggregate evidence is committed
as [retention-production-20261022.json](../../test/fixtures/retention-production-20261022.json),
including diagnostic/deployed revisions, scope, bounds, retained query status,
source-specific reconciliation and ingestion records. It contains no customer-level
records. The snapshot/collection are preserved; no saved job was replayed.

## Follow-up investigation: exact predicate and transaction pipeline

The [pipeline investigation](retention-pipeline-investigation.md) traces actual
canonical transaction writers and names finance_refresh_runs/state and
customer_refresh_runs/state, which the earlier candidate inventory did not inspect.
It distinguishes update-window completion, selected-ID repairs, full-bootstrap
completeness, cross-table eligibility and retired-source lifecycle evidence.
The exact-result check has now completed and confirmed the null product_ref.
The shared boundary fix and separate finance investigation supersede that blocker.
The previous broad diagnostic is complete and must not be rerun. PR remains draft.
