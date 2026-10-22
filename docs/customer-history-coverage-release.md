# Completed collection: coverage review, publication and business analysis

## Evidence and scope

As of 2026-10-22 the operator reports complete: WW/USD/Shopify rosters, Shopify
shopify, USD metorik_orders, WW metorik_orders and retained at
history-20261020-v2; additionally WW metorik_orders at
history-20261021-billing-v3. These are production reports, not local provider
verification. No recollection, checkpoint repair, evidence deletion or activation
is part of the statement-budget PR. The merged #363 extraction is retained.

The 30s statement cap is a sizing correction motivated by a successful 13.272s
stage, not a proven diagnosis of the later cancellation. Whole-script ceilings,
linkage SQL, exclusions, full-roster denominators and publication atomicity remain
unchanged. Local gates cannot establish production execution success.

## Subsequent separately authorized release sequence (not executed)

1. Review/merge/deploy the PR separately. Keep collectors stopped through coverage
   review and publication. Confirm `git rev-parse HEAD` and `RENDER_GIT_COMMIT`
   correspond to the reviewed change; compare deployed history-budgets.js.
2. Read aggregate progress once and verify every completion listed above. Then
   run one bounded preview, inspect exit status and retain the aggregate output:

   ```sh
   timeout --signal=TERM --kill-after=5s 45s node customer-identity/history.js status --dataset=customer_identity
   timeout --signal=TERM --kill-after=5s 125s node customer-identity/history.js preview --dataset=customer_identity
   ```

   A failure stops this release sequence. Do not automatically rerun preview or
   increase another budget. A dry run cannot validate all temporary-table stages.
   Coverage success requires delivered aggregate results, not just child success.
3. Review every store's matched/unmatched/ambiguous/unavailable counts against its
   full original-order roster: the four mutually exclusive states must sum to the
   denominator. Review conflicts, shared-email exclusions, guests and usable versus
   extraction-failure/unavailable evidence. Require supported positive cross-source
   matches. Progress completion alone is not linkage coverage or follow-up proof.
   Record source/date/classification gaps rather than dropping them to improve rates.
4. After coverage review, authorize publication separately. Use a new immutable
   snapshot name, for example history-20261022-billing-v3 (first verify unused).
   The completion revision MUST remain history-20261020-v2; v3 has no new rosters
   or Shopify checkpoint. All email_observations participate across revisions;
   neither preview nor publication filters observations to the completion revision.
   This includes corrected WW direct order emails plus preserved earlier evidence
   and conflicts. Observations have no revision column: do not claim per-revision
   observation totals or derive them from collection counters.

   ```sh
   timeout --signal=TERM --kill-after=5s 245s node customer-identity/history.js publish --dataset=customer_identity --snapshot=history-20261022-billing-v3 --revision=history-20261020-v2 --apply
   ```

   The existing transaction checks prerequisites, materializes the graph, inserts
   links, asserts positive matches and inserts readiness before COMMIT. Do not
   separate these writes. Any failure/unknown outcome requires same-job terminal
   metadata and snapshot-state review before another publication; never replay
   blindly or activate an unverified snapshot. Readiness is not proof of analytical
   follow-up or product coverage. A previously used snapshot name cannot be reused.
5. Validate the published snapshot with the existing shared summary path:

   ```sh
   timeout --signal=TERM --kill-after=5s 60s node customer-identity/history.js check --dataset=customer_identity --snapshot=history-20261022-billing-v3
   ```

   Require exit zero and valid=true, with no identity fallback. This check does
   not change the running service or verify every downstream business calculation.
6. Only after separate activation approval, configure the reviewed snapshot:

   ```text
   ORACLE_CUSTOMER_IDENTITY_MODE=email_candidate_v2
   ORACLE_CUSTOMER_IDENTITY_DATASET=customer_identity
   ORACLE_CUSTOMER_IDENTITY_SNAPSHOT=history-20261022-billing-v3
   ```

   Verify the snapshot/identity metadata through direct, interactive and durable
   recovery paths without repeating provider work to repair presentation. Disable
   the mode for runtime rollback; preserve the immutable snapshot and evidence.

## Business deliverable acceptance contract

The requested report is downstream work, not a result established by successful
linkage. No business counts/rates are claimed by this PR. Retain the existing
original-order/import-deduplication contract: Matrixify copies can supply identity
evidence but cannot become additional purchases, first orders or return orders.
Do not equate native and Metorik customer-ID namespaces. Use governed eligible
purchase statuses/channels and disclose unsupported channels/source periods.

Deliver named collaboration aggregates AND named individual first-purchase items
within each collaboration, plus individual product rankings across the eligible
population. Use governed product references and classification evidence; never
infer collaboration/core-range membership from missing labels. Disclose unknown
classification and identity exclusions. A first basket can contain multiple items
or collaborations: count a customer once within each group and disclose that group
totals overlap; never add product cohorts into a sitewide customer denominator.

For each group and comparable sitewide cohort period, show first-purchase customer
count and, separately for 90, 180 and 360 days: eligible mature denominator, repeat
customer count and repeat rate. Repeat means a distinct later eligible original
order within the window, counted once per customer/group/window. Rank products by
both repeat-customer count and rate, with denominators visible; identify the ranking
window and use deterministic ties. Apply a declared minimum denominator (for
example 30) to rate rankings and show smaller cohorts separately as small samples.
Do not hide low/zero returns. Consider uncertainty intervals for rate comparisons;
these are descriptive associations, not causal effects of the first item.

Maturity requires the full calendar-day window after entry within the common
evidence-backed observation cutoff AND continuous coverage of the relevant source
history. Use the last verified coverage date, at most 2026-10-19 for this frozen
history, not today's date or latest activity as a completeness certificate. Report
immature, incomplete-coverage and unlinked customers separately. An observed repeat
without certified follow-up can be reported as observed evidence, but cannot be
divided by an unverified mature denominator. Null/unsupported rates are not zero.
Preserve prior-history uncertainty: 1900 is a technical selection bound, not proof
of complete lifetime history; label first-observed purchases unless earlier history
is independently verified.

Sitewide baselines must use exactly the same entry periods, eligible population,
identity snapshot, channels, status/import exclusions, observation cutoff and
window-specific maturity rules as the item/collaboration cohorts. Show baseline
rates over time rather than comparing differently matured launch cohorts. Report
source/channel coverage and unknown/unlinked shares with each period.

Bonus tables: named second-order products and same/other collaboration/core/unknown
buckets using existing governed classification; median and distribution of elapsed
time to second eligible original order. Medians are conditional on observed returns
in the stated mature cohort/window; disclose ties, missing product lines and mixed
baskets. Do not treat nonreturners as zero-day returns.

### Existing analytical gaps to resolve before claiming the full report

Current customer-journey and retention contracts explicitly support 90/180 windows;
360 is rejected/not emitted. Publication/activation will not add 360 support. A
separate shared-contract change must cover validation, tool schema, SQL windows,
maturity/coverage checks, baseline comparability, ranking and rendering, with
cross-source/direct/interactive/durable regression gates. Do not approximate it by
doubling a 180-day rate or silently substitute a shorter window. Named item and
collaboration output, classification coverage, calendar-period baselines, second
orders and prior/follow-up completeness must be verified on the selected snapshot
before delivery. These are explicit remaining acceptance requirements, not reasons
to recollect completed identity evidence or enlarge this preview-sizing patch.
