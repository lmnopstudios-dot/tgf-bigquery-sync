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

The absent entries cannot be individually certified as zero eligible customers,
unmapped history, or truncated from the rendered table. The SQL fix returns all
current collection entries outside the ranking limit, with eligible first-customer
and historically classified-product counts. A positive eligible count with no
returned summary establishes truncation; zero products uses the catalogue count.
Zero eligible customers with positive historical classification evidence is reported
separately. No historical classification evidence is flagged as missing evidence:
it does not prove historical transactions existed or a classification is wrong.

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

The exact unresolved fact is which intervals have independently verified continuous
eligible **original transaction** coverage for Woo WW, Woo USD and Shopify, including
channel scope, gaps and retirement boundaries, with evidence references. Migration
handoff coverage outside a common certified interval also needs independent proof;
this fix conservatively does not synthesize it. Prior-history completeness remains
a separate uncertainty. No supplied evidence certifies those intervals. It is not
possible here to determine whether an inaccessible retained ingestion attestation
contains them.

## Shopify failure and remaining requested sections

An exact bounded SELECT of the supplied saved job and request was attempted using
existing credentials. It failed before warehouse execution at token acquisition:
HTTP 403, `Could not refresh access token: Domain forbidden`. No saved result,
population SQL, query metadata or original provider error was retrieved. This is an
access failure in this environment, **not** the retained Shopify baseline failure.
The pasted report confirms that component failed but omits its retained error and
query ID. No speculative SQL repair or replay is presented as its resolution.

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
tests; no new production counts are claimed. The actual Shopify baseline failure,
exact live catalogue reconciliation and live transaction coverage evidence remain
open requirements before the business report is complete.

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

Final gate results are recorded in the PR. No collection, republication, repair,
classification write, identity-setting change, IAM change, deployment or merge is
part of this change.
