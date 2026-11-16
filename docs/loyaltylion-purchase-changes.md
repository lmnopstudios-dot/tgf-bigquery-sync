# LoyaltyLion purchase changes and refresh

Run `LoyaltyLion performance report` in Oracle after deployment. The authenticated
workbook adds **Purchase changes** alongside Customer purchasing and Enrolment
cohorts. This change does not run collection, certify commerce history, enable a
cron or deploy the service.

## Reading the comparison

| Column group | Meaning |
| --- | --- |
| window_days | Equal 30, 90 or 180 elapsed days either side of each person's recorded enrolment |
| paired_aov_customers | People with at least one qualifying native Shopify order on both sides |
| paired_before/after_orders and gross | Orders and original discounted gross for exactly that matched population |
| before/after_aov | Gross divided by orders, tax and shipping included, before refunds |
| aov_change_amount / fraction | After minus before; fraction divides the change by before AOV |
| paired_repeat_customers | People with at least two qualifying orders on both sides |
| paired_before/after_gap_count | Consecutive within-window intervals contributing to that sample |
| before/after_mean_gap_days | Mean of each matched customer's own mean order interval; each customer has equal weight |
| before/after_median_gap_days | Median of those customer-level means; not the median of all individual order gaps |
| mean_gap_change_days / fraction | After minus before; negative means shorter observed gaps; fraction divides by before mean gap |
| *_withheld_reason | Why a comparison or percentage is blank; blank never means zero |

For example, £100 before and £120 after gives +£20 (+20%). A 40-day mean gap
before and 30 days after gives −10 days (−25%). These are synthetic examples.

Keep channel and currency separate. Zero-purchase members stay in the wider
cohort counts but cannot enter paired AOV; one-order customers cannot establish
an order gap. The paired AOV and repeat-order samples can therefore differ.
Cancelled and known migrated Shopify copies are excluded by the existing
qualifying-order rules. Exact order IDs are deduplicated before comparison.

Order gaps do not cross enrolment or either window edge. Waiting for an unobserved
next order is censored, not a zero interval. Distinct same-timestamp orders can
produce zero gaps. Elapsed-time arithmetic is independent of London DST; London
calendar dates still select the enrolment cohorts.

AOV comparisons are blank if matched order values are missing. Gap comparisons
can still be supported independently. Both require mature, fully certified
commerce windows. Observed counts remain visible when certification is missing;
customer-link repair alone is not proof of complete order history. A percentage
with a zero before denominator is unavailable even if an absolute change exists.

These are **associations around enrolment**, not proof LoyaltyLion caused the
change or a comparison around an assumed global launch date. Promotions, customer
self-selection and tenure can explain differences. No statistical significance,
incremental revenue or causal ROI is asserted. Existing monthly current-member
versus current-nonmember AOV remains in Customer purchasing, explicitly using
current membership rather than membership at purchase.

Old retained workbooks keep their original tab layout; the new tab is versioned
within the existing five-section performance evidence contract. Failed cohort
reads leave that tab unavailable while successful sheets survive.

## Refresh existing retained data safely

Run the existing read-only status first from the deployed Render checkout:

```bash
LOYALTYLION_CONFIG_PATH=/etc/secrets/loyaltylion-account.json \
LOYALTYLION_HISTORY_PLAN_PATH=/etc/secrets/loyaltylion-history-plan.json \
LOYALTYLION_COLLECTION_ENABLED=false \
timeout --signal=TERM --kill-after=5s 75s \
node loyaltylion/history.js status
```

Review complete windows and the guard before any replay. `next_window: null`
only means the reviewed historical span is complete; it does not establish that
points are caught up to today. Use the existing private reviewed plan; do not
print it, overwrite it with an example, or raise limits automatically.

After review, a bounded full roster preview is:

```bash
LOYALTYLION_CONFIG_PATH=/etc/secrets/loyaltylion-account.json \
LOYALTYLION_HISTORY_PLAN_PATH=/etc/secrets/loyaltylion-history-plan.json \
LOYALTYLION_COLLECTION_ENABLED=false \
timeout --signal=TERM --kill-after=5s 16m \
node loyaltylion/history.js roster --preview
```

A separately authorized first write uses the same paths with
`LOYALTYLION_COLLECTION_ENABLED=true` and `roster --apply`. A recent points
preview uses `incremental --preview` only when the reviewed plan explicitly
allows incremental collection and its historical span is complete. Its separate
write is `incremental --apply`, one bounded window at a time. If incremental is
disabled or gaps remain, follow the reviewed gap-first history plan rather than
changing the gate. Reconcile uncertain runs and guards before any retry.

The existing setup, bounds, daily cron and recovery instructions are in
[loyaltylion-history-performance.md](loyaltylion-history-performance.md). A roster
refresh changes membership observation time; report generation time does not.
Refreshing loyalty data does not itself certify Shopify commerce coverage or
establish actual voucher redemption or historical tier state.
