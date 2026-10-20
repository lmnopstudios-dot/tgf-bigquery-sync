# Retention follow-up coverage and delivery

## Demonstrated cause

At merged main `0f772bb` (PR #346), `retention_members` defined maturity as entry date plus 90/180 days no later than the requested observation cutoff. It never checked continuous source observation coverage. The requested October 2026 cutoff therefore allowed all sufficiently old Woo entries to become mature even though the supplied activity evidence ended in November 2025. This demonstrates a calculation-contract defect; it does not prove collection completeness, an exact migration boundary, or the production state of other sources.

Repository guidance confirms Woo is retired (`oracle-data-freshness.md`); its exact operational end remains unconfirmed (`annual-location-recorded-tax.md`). Public Shopify launch on 20 November 2025 is not a continuous-coverage certificate for either platform. Neither latest order activity nor launch dates are promoted to coverage evidence.

## Shared implementation

All three retention projections (collaboration, entry product and nested pieces) require the entire entry-to-window interval to fit within a deployment-owned, evidence-backed continuous-coverage certificate and the requested observation cutoff. The certificate is source/store qualified and includes start, end, calendar timezone and evidence reference. A certificate in a different timezone cannot establish the requested calendar window. It is an internal dependency, never a model/tool argument. Production currently supplies no certificates: supported mature counts are zero, maturity is labelled unverified and rates remain unavailable. Zero supported mature customers does not mean no old customers exist.

`observed_repeat_customers` counts identifiable eligible subsequent purchases within each window independently of verified maturity. The existing `repeat_customers`, conditional median and second-purchase buckets continue to describe only the verified mature population. Observed returns outside that population survive in evidence and Show details. A verified certificate may produce different 90-day and 180-day denominators; late entries and entries before its start do not become fully observed merely because calendar time elapsed.

The existing production factory already uses transactional decomposition for Woo WW, Woo USD and Shopify. This change preserves that path, single-job ownership, snapshot, temporary-only materialisation, independent partial outcomes, cancellation, polling fencing, deadlines and billing caps. It introduces no collection or persistent warehouse writes. Missing coverage is distinct from failed reads, empty reads and unclassified populations.

Presentation separates source tables and pairs 90/180 results on each named cohort row. The primary requested window controls ranking; generic collaboration membership never competes. Cohort sizes stay visible. Fewer than 30 mature customers is disclosed as a small sample; no size-based exclusion or statistical-significance claim is applied. Explicitly core-only first orders have their own classification-coverage count; the remaining unknown/other bucket is not assumed to represent unclassified collaborations. The native safe Show details block contains history, linkage, coverage and diagnostic limitations; browser tests verify that HTML markers are not rendered literally. Old saved evidence without a coverage contract cannot recover confident rates through the shared delivery validator.

## Prior supplied live evidence (not re-executed here)

The user's truncated Render evidence established these Woo WW rows, with entry period 2023-10-19–2026-10-18 and requested cutoff 2026-10-18. The previous maturity counts cannot establish verified follow-up. These are observed returns, not a defensible mature retention ranking:

| Collaboration | First-observed customers | Observed repeat within 90 days | Observed repeat within 180 days | Mature denominators / rates |
|---|---:|---:|---:|---|
| END | 7 | 1 | 1 | Unverified / unavailable |
| Dr Martens | 18 | 2 | 3 | Unverified / unavailable |
| RD O Studios | 54 | 4 | 6 | Unverified / unavailable |
| Sammi | 8 | 0 | 1 | Unverified / unavailable |

Supplied coverage: 3,501 eligible first-observed customers; 87 named, 5 generic-only, 3,409 unknown/other under the previous coverage partition. That last figure cannot establish how many were explicitly core-only; the new field requires re-execution. Activity endpoints were 2021-03-25–2025-11-20. No missing top-level diagnostic fields, Woo USD rows or Shopify rows are inferred. No cross-platform customer bridge is established. No mature 90-day winner is supported by these observations alone.

## Calculation and regression validation

`test/observation-coverage.test.js` covers certified retirement boundaries, uncertified latest activity, separate requested cutoff, 90/180 maturity differences, observed returns outside certified follow-up, duplicate membership, partial source failure, London yesterday, direct delivery, interactive retained export, durable authenticated polling/recovery, and rejection of legacy saved denominators.

The local SQL regression requires Python 3.11+ with its standard-library SQLite support; it installs no SQL engine package. The suite executes factory-owned membership, maturity, median and aggregate SQL relations over synthetic inputs via a documented SQLite dialect adapter. Its independently checked result is three unique entries and two observed returns at both windows; certified coverage supports two mature customers and one repeat (50%, median 10 days) at 90 days, and zero mature customers/no supported rate at 180 days. Without certification both rates are unavailable and both observed returns remain. This validates calculations beyond presence of rows or copied scope stamps. It is not BigQuery SQL/schema verification: source/classification relations still require the bounded live production check.

The persistent acceptance matrix includes the new coverage suite. Existing campaign, country conversion, basket, source isolation, ownership, cancellation and delivery regressions remain release gates. The browser suite also exercises unverified-coverage tables, a failed independent source, native Show details and durable refresh at desktop/mobile widths without provider replay.

## Live source execution

The configured read-only source probe was attempted for all three sources on 20 October 2026. Each failed at OAuth token acquisition (`oauth2.googleapis.com`, HTTP 403); no source SQL dry run or warehouse calculation was verified. The production-answer binding command likewise returned three rejected source outcomes and no rows. Its dates resolved to 2023-10-20–2026-10-19 with requested cutoff 2026-10-19, Europe/London. These workspace access failures do not establish any Render execution failure or root cause.

## Next indispensable Render check

From the checkout containing this implementation, using Render's existing configured identity, run exactly:

```sh
timeout 65s node diagnostics/oracle-retention-answer.js
```

This command has no required flags. It uses Oracle's actual production provider factory and answer contract, starts the three independent reads under one 45-second deadline, and emits one compact JSON object with source outcomes, classification/history coverage, requested cutoff, actual validated cohort rows and the answer. It uses the current London date and excludes today. It performs aggregate reads with existing bounded transient query work; it does not deploy, create persistent tables, collect or mutate data. A nonzero exit or rejected component is a failure, never zero retention. Retain the full single JSON object rather than a mid-object excerpt. With the present absence of certificates, successful execution must still return unverified maturity and unavailable rates; identifiable returns should remain visible.

## Deployed Oracle delivery and recovery

Local direct/interactive/durable/browser recovery verification is separate from deployment. No deployment or merge was performed or authorized. The deployed Oracle revision, actual Render warehouse SQL outputs, source completeness and production browser recovery remain unverified. Fixture counts, SQL dialect adaptation and successful cancellation are not production readiness. Before claiming a completed deployed business answer, verify the actual three-source result above, then the same question in authenticated Oracle and after refresh, with no duplicate provider execution. A source coverage certificate or verified linkage bridge needs evidence; this change does not fabricate either.
