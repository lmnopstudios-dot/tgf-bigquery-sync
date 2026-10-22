> Current status: #382 merged/deployed and passed live acceptance at `c22df6162b9e1abdd29c8e628cdaab045496961b`; report `279fea44-4f76-4723-9936-a0f39d916a8e` returns all requested software sections. The #370 merge discussion below is historical. Continue the [current mapping/coverage completion and single bounded evidence read](retention-mapping-coverage-completion.md), preserving its live successes. Coverage certification remains unresolved; this plan does not authorize collection or certificate writes.

# Review decision and finite retention coverage verification

## Report fix disposition

**Recommend merging #370 after normal review/CI.** The null-reference baseline
failure is reproduced and fixed at the shared attribution boundary. Governed
catalogue reconciliation, independent limits, requested sections, strict source /
identity / denominator validation and partial delivery are reviewable source fixes.
The recorded acceptance gate passed 764 tests sequentially; desktop/mobile browser
checks passed. No source code has changed since those checks.

The historical finance investigation is **closed: cause unresolved**. Six exact
failed-run error strings are empty; no original structured exception or failed
warehouse job error is accessible here. A locally reproduced SDK error-message
loss is a mechanism, not a diagnosis of those runs. Do not make historical
attribution or collector recovery a prerequisite for merging the report fix.
Reopen only if an existing structured record is actually supplied. Do not restart
a collector to obtain one. The separate logging change cannot recover old errors.

Merging #370 does not deploy it, certify a complete business report or enable
mature rates. Review/deployment and any future read-only production verification
remain distinct actions. Named historical mapping gaps, current governed rather
than certified purchase-time classifications, first-observed rather than first-ever
entry, frozen analytical linkage, observed repeat counts and unverified mature
follow-up remain explicit limitations. The report keeps unsupported rates null;
missing mappings/history remain unknown, not zero customers.

## One finite evidence request

Request one package of **existing** source inventories/manifests and a matching
read-only warehouse extract. Do not search more datasets for a certificate.
The package has four source partitions:

| Partition | Scope | Evidence required |
|---|---|---|
| Shopify delta | created OR updated in [2026-10-19T14:17:24.265Z, 2026-10-19T23:00:00Z) | Exhaustive original order IDs, original timestamps, app/import/channel provenance, financial/refund/cancellation state and source access/export scope; include older orders changed in that interval |
| Shopify bootstrap | Earlier original native-order history used by the report, through the same cutoff | Existing full inventory plus completion/pagination/source reconciliation manifest; an update-window run union cannot substitute |
| Woo WW | Canonical original order history through evidenced retirement; later eligible adjustments through cutoff if any | Complete retained Metorik inventory/export and retirement/no-new-orders/adjustment evidence for the WW store |
| Woo USD | Same requirement for the USD store, independently | Complete retained Metorik inventory/export and lifecycle evidence for USD |

Each manifest must specify source/store, extraction method and filters, channels,
original ID namespace, interval and timezone, retrieval time, financial-state
semantics (current state versus an actual cutoff snapshot), pagination/exhaustion
or export-completion evidence, row/key counts and a checksum. A manifest claiming
completeness without the underlying source-key evidence is insufficient. Include
archived/deleted records or explain any unavailable population. No emails or
customer names are needed. Include Shopify imported copies as source records
with explicit app/exclusion provenance, or supply a complete audited exclusion-key
list; never silently waive warehouse-only keys as migration copies. Preserve the
report's imported-order exclusions when comparing eligible sets. Existing
customer IDs/guest flags may be compared
locally; frozen identity mappings must not be changed.

**Action required now:** a source/data owner supplies that retained package, or
states exactly which partition/fields/lifecycle facts were not retained. This is
an evidence handoff, not a request to run a collector. If a partition is missing,
stop that partition. The only proposed subsequent action is a separately authorized,
bounded **read-only** source order-key/state verification for its specified range;
no ingestion, import, backfill, state reset or warehouse write is implicit.
If historical status snapshots are unavailable, a current API response cannot
establish historical cutoff state; retain that limitation instead of certifying it.

## Warehouse extraction and comparison contract

Use the existing reporting identity for SELECT-only exports. Do not load source
inventories to production. Bind source inventory IDs as an ARRAY<STRING> parameter
(or use an already-retained local warehouse extract); neither requires a table
write. Set a deadline and billed-byte cap before execution. No report/job replay.

For the Shopify delta, the following is the exact extraction shape for the three
baseline input tables. Bind @source_order_ids from the complete delta source
inventory, @from to 2026-10-19T14:17:24.265Z and @to to 2026-10-19T23:00:00Z as
TIMESTAMPs. Replace PROJECT only with the configured project identifier. An
operator must confirm inventory scope and bounds before issuing this SELECT;
use a 30-second deadline, at most 1 GB billed per export, and at most 50,000
source/candidate IDs per declared partition. If output is truncated or exceeds
the bound, that partition is unknown until disjoint complete chunks are supplied;
it is **prepared, not executed**. Scope includes source-only IDs and warehouse
candidates, so missing source keys are not silently removed by a warehouse join.

```sql
WITH candidate_ids AS (
  SELECT id AS order_id FROM UNNEST(@source_order_ids) id
  UNION DISTINCT
  SELECT order_id FROM `PROJECT.shopify_data.order_locations`
  WHERE (created_at >= @from AND created_at < @to)
     OR (updated_at >= @from AND updated_at < @to)
  UNION DISTINCT
  SELECT order_id FROM `PROJECT.shopify_data.order_financials`
  WHERE (created_at >= @from AND created_at < @to)
     OR (updated_at >= @from AND updated_at < @to)
  UNION DISTINCT
  SELECT order_id FROM `PROJECT.shopify_data.order_customers`
  WHERE order_created_at >= @from AND order_created_at < @to
), locations AS (
  SELECT l.order_id, COUNT(*) AS row_count,
    ARRAY_AGG(STRUCT(l.created_at, l.updated_at, l.retail_location_id,
      l.source_app_id, l.synced_at) LIMIT 2) AS evidence
  FROM `PROJECT.shopify_data.order_locations` l JOIN candidate_ids USING(order_id)
  GROUP BY l.order_id
), financials AS (
  SELECT f.order_id, COUNT(*) AS row_count,
    ARRAY_AGG(STRUCT(f.created_at, f.updated_at, f.original_total_presentment,
      f.total_refunded_presentment, f.presentment_currency, f.synced_at) LIMIT 2) AS evidence
  FROM `PROJECT.shopify_data.order_financials` f JOIN candidate_ids USING(order_id)
  GROUP BY f.order_id
), customers AS (
  SELECT c.order_id, COUNT(*) AS row_count,
    ARRAY_AGG(STRUCT(c.order_created_at, c.customer_id, c.is_guest,
      c.cancelled_at, c.display_financial_status, c.synced_at) LIMIT 2) AS evidence
  FROM `PROJECT.shopify_data.order_customers` c JOIN candidate_ids USING(order_id)
  GROUP BY c.order_id
)
SELECT i.order_id, l.row_count AS location_rows, l.evidence AS locations,
  f.row_count AS financial_rows, f.evidence AS financials,
  c.row_count AS customer_rows, c.evidence AS customers
FROM candidate_ids i
LEFT JOIN locations l USING(order_id)
LEFT JOIN financials f USING(order_id)
LEFT JOIN customers c USING(order_id)
ORDER BY i.order_id
```

Counts greater than one are failures requiring review, not permission to choose
a representative row. The two-row examples are diagnostic only; comparison must
not accept a duplicate key. SQL absence is missing input, not zero source orders.
For Shopify bootstrap, use the same three-table projection but form candidate_ids
from the complete ID universe of all three canonical tables plus the full source
inventory, not a creation-date filter. This prevents corrupted/older warehouse
timestamps or orphan customer rows from hiding warehouse-only keys. Account for
imports explicitly; report first-observed history depends on lookback too.
For each Woo partition export orders by order_id with row count and the actual
report fields: order_created_at, customer_id, status, currency, total,
total_refunds, order_updated_at and synced_at. Compare each store separately.
If an interval is too large for one bounded export, use deterministic disjoint
ID/date partitions with a manifest of every partition, counts and checksum;
no repeated report calculation is needed.

Perform the comparison locally, retaining aggregate discrepancies:

1. Verify artifact checksum, source completeness declaration and scope. Reject
   ambiguous ID namespaces, missing required fields and incompatible financial
   state semantics. Do not manufacture a common as-of snapshot.
2. Full outer compare native source order IDs to warehouse IDs. Count source-only,
   warehouse-only and duplicate identities in both. Do not filter to eligible
   orders first: missing cancellation/refund/status evidence can change eligibility.
3. For matched unique IDs compare original dates, customer/guest identity fields,
   channel, import provenance, currency, order total, refund total, financial status
   and cancellation. Distinguish null/unavailable from a real zero/false. Apply
   exactly the report's eligibility predicate to both complete sides and compare
   eligible key sets. Compare money as exact normalized decimals, not binary-float
   approximations. Missing a required financial/customer record fails coverage.
4. Separate item/classification verification: compare source order/line/product keys
   to actual order_line_items for each store. This verifies product attribution,
   not baseline order completeness, and cannot write or infer governed mappings.
5. Output partition pass/fail/unknown, both key counts, anti-join counts, duplicate
   counts, per-field mismatch counts, eligibility-set differences and source /
   warehouse artifact references. Stop on missing evidence; do not auto-repair.

## What a pass establishes, and what remains

A zero-discrepancy delta result against an evidenced exhaustive source inventory
establishes matching order existence and eligibility state **only for that delta
and declared snapshot semantics**. It does not establish the earlier bootstrap,
complete follow-up across all stores, verified people, first-ever purchase,
historical product classifications or a retention rate. An equal total alone
is not a pass. A nonzero difference locates missing/mismatched inputs; it does
not authorize recovery.

Bootstrap partition passes plus evidenced successful update-window maintenance,
compatible cutoff state and Woo lifecycle facts can support a proposed complete
interval per source/store/channel. A data owner reviews the aggregate evidence
and references. Only then may a separate, reviewed configuration change supply
certificates to the existing consumer. **No certificate is written by this plan.**
The current linked consumer requires a common evidenced continuous interval;
unsupported pre-launch/post-retirement periods cannot be filled from last activity.
If supplied evidence supports only a handoff union that the current contract cannot
express, retain null rates and review that interval model separately. Do not relax
the safeguard as part of this verification.

Finite stopping points: retained evidence supplied → one bounded export per
partition (or its declared disjoint chunks) → local discrepancy report → owner
review → either documented supported intervals or a precise list of still-missing
facts. There is no automatic collector/retry/repair loop. Historical finance cause
is not a dependency of any step.


The independent, prepared [finance logging fix is draft #371](https://github.com/lmnopstudios-dot/tgf-bigquery-sync/pull/371).
It captures future bounded diagnostics only and is not a dependency of this plan
or a claim about the closed historical cause.
