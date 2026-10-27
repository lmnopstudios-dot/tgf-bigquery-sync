# Collaboration-entry next-order products: 38f9aa99

## Retained production evidence

The operator ran the request-specific read on Render and supplied its complete
JSON output. Exactly one retained execution was found; neither the inventory nor
warehouse-job list was truncated. Analysis job
`39db290f-9f86-47a7-b8e1-3162337a4c90`, attempt 1, completed with lifecycle stage
`evidence_validation`. Both requested and execution revision were
`b8f81236f27cf099f74a5f092f16fa29b08731a9`.

| Component | Warehouse job (US) | Retained outcome | Warehouse metadata |
|---|---|---|---|
| `tgf/combined/retention_windows` | `d1461b8e-0944-47e2-baa9-f63001b2a263` | rejected at `population_query`, `ORACLE_AGENT_DEADLINE`, `request_deadline`, population unavailable | `DONE`, errors `[]` |
| `tgf/combined/retention_piece_windows` | `838b3a3b-a28e-4e1b-acc9-6507e50f7cbf` | rejected at `population_query`, `ORACLE_AGENT_DEADLINE`, `request_deadline`, population unavailable | `DONE`, errors `[]` |

There was no recorded provider reason, BigQuery reason, error category, HTTP
status or statement location. Section outcomes and root validation errors were
empty. The actual recorded failures are expiration of the request deadline at
the population-read boundary, not warehouse SQL errors. Warehouse completion
without errors does not establish when results became available to the caller,
why the request budget was exhausted, or successful report delivery. No runtime
profile or timing was retrieved, and no SQL optimizer defect is inferred.
Neither SQL repair nor deadline increases are justified by this evidence.

Saved context selected `analyze_customer_journey`, `journey_intent=retention`,
`journey_group_by=collaboration_piece`, collaboration entry classification and
`first_observed_ever`. Entry dates were 2022-10-19 through 2026-10-19; observation
cutoff was 2026-10-19; channel was unrestricted. This confirms the retention
routing described by the user. The original exact prompt was not retained by
this diagnostic; the new prompt fixture records the requested semantics rather
than claiming verbatim provenance.

## Intent and implementation

The old product route required popularity wording and an unrestricted entry
population; collaboration retention could therefore own a next-order product
question. A retention report's collaboration buckets and bonus product samples
do not satisfy the requested full-range product ranking.

The new shared `collaboration_purchase_products` operation has a separate strict
evidence contract and provider grouping. It combines linked eligible history
before first-observed selection, selects entry-order lines with one governed
named collaboration and no classification conflict, and deduplicates the overall
population by linked customer. Named-collaboration and collaboration/item
memberships may overlap; their counts never form the overall denominator.

The calculation reuses the existing product-journey distinct-customer counts,
next strictly later eligible order, approved reporting identities/families,
returning-customer denominators, product shares and continuous-coverage rules.
Next-order lines are unrestricted across the range. Missing lines and unidentified
products remain in returning-customer denominators. Ring Sizers remain separate.
Only entry membership, breakdown keys and independent entry-cohort quotas differ.

The bounded report shows the top 20 named collaborations and top 20
collaboration/item cohorts by distinct entry customers (Ring Sizer item cohorts
have a separate top-20 quota). Overall product selection is top 20; each
breakdown shows top five, with independent Ring Sizer product quotas. Available
counts and truncation are explicit, and quotas never restrict overall membership.
Primary results use the next order by cutoff, with separate 90/180/360-day views.
Verified rates require continuous coverage; observed results remain provisional.

Each section validates independently before entering evidence. Invalid overall,
named or item sections are explicitly unavailable while independently validated
sections remain visible. Persisted context/definition comparisons ignore JSON
object member order and still reject changed populations, periods or identity.
Direct, interactive, durable polling and browser recovery use the same validator.

Accepted collaboration-retention and whole-range second-purchase calculations
and contracts are unchanged. No deadlines, collection, mapping decisions or
production replay changed. A single product calculation replaces the incorrectly
selected pair of full retention reports for this intent; this is a semantic
routing change, not a claimed performance fix for those accepted reports.

## Validation boundaries

End-to-end tests run the real provider factory and generated execution script
against aggregate fixtures, checking arguments, routing, evidence mutation,
subject switches and durable recovery without another provider read. The browser
gate checks desktop/mobile visible output and serialized refresh.

`test/collaboration-journey-sql.py` executes the real generated calculation
locally after BigQuery-to-DuckDB translation against synthetic linked eligible
orders. It covers duplicate entry/return lines, overlapping collaborations/items,
core and other-collaboration products, repurchases, unknown and missing lines,
late returns, prior purchases, tied timestamps and empty cohorts. It does not
verify BigQuery planning, warehouse performance or production customer linkage.
The full production provider retains its existing linked-history integrity and
imported/cancelled/refunded-order exclusions, locked by SQL and existing tests.
Live warehouse/report acceptance remains unverified because this environment
cannot authenticate to Google (HTTP 403 `Domain forbidden`). No automatic replay
is part of this change.

Final local gates on the rebased implementation:

- `npm run test:oracle:acceptance`: 888 passed; zero failures, cancellations or skips.
- `npm run test:oracle:browser`: passed desktop/mobile, including full and partial
  collaboration-entry reports and serialized refresh without another provider read.
- Focused collaboration-entry suite: 10 passed.
- Generated synthetic SQL: populated (24 cohort/window rows) and empty (four
  overall window rows) executed locally; warehouse verification remains false.
