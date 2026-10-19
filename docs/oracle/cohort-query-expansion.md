# Cohort query expansion investigation

Base: latest fetched main a5a2bc4 (merged PR #339), branch fix/cohort-query-expansion. No deployment, merge, collection, backfill or source mutation.

## Production evidence (operator supplied)

Woo WW resolver: dry run 938 ms, results by 4309 ms. Classification population: dry run 1783 ms, results by 6888 ms; named 90 lines/87 customers, generic-only 5/5, absent 4453/3421. Customer counts overlap and cannot be summed as exclusive cohorts.

Full provider request 6d3d0d07-5e6a-4281-bd28-b1cd155c7d88: SQL hash afedbb5ded3537f2b162058f5d08238ef04db01e2a7c114117165e443983b63c, 25,182 bytes, 55 CTEs; authentication 178 ms; dry run deadline at 15,010 ms. This isolates a difference after classification, but does not prove planner complexity or an execution bottleneck.

## Generated SQL comparison

The classification-stage diagnostic retains the provider WITH prefix but selects only entry_stage_coverage. Unreferenced CTE definitions are not evidence of executed work. Its reachable path includes deduplicated orders, source-qualified eligible customers, full-history row numbering, first-observed entry selection, governed resolver and classified entry lines.

The full retention result additionally reaches:

- entry_matches: product/name eligibility, distinct customer/product/name entry membership. Entry coverage joins first-order lines to these matches by customer, potentially multiplying intermediate rows; boolean coverage aggregation preserves final coverage.
- cohort and downstream_orders: deduplicated customer entry, join back to ranked eligible history, strictly later purchases and requested channel/source filters. The first subsequent order is selected before classifying its product mix.
- order_classification_sets: per-order arrays of names, core counts and unknown/conflict counts, joined by platform/store/order to the first subsequent purchase.
- retention_members: unique customer/name (or customer/name/piece) crossed with 90/180-day windows; maturity uses full calendar days and elapsed repeat time remains timestamp based.
- median, totals, ranking and coverage: the old median CTE read retention_members, then totals read retention_members again and joined the distinct per-group median back. Coverage adds independent entry and history branches. General downstream product/currency aggregates are defined but not reachable from retention output.

The bounded change removes the demonstrated duplicate member dependency: an analytic median travels with each member row, and totals aggregate that stream directly. The old median relation has exactly one row per non-null grouping key/window, so joining it back cannot alter member multiplicity. The new expression uses the identical mature-only median input. No eligibility, source identity, first-observed ordering, repeat selection, classification, denominator, limit or independent-source delivery changes. No deadline increases or validation removal. This reduces a structural expansion opportunity; a production speedup is not yet demonstrated. Materialized scripting/decomposition is deferred until stage measurements justify its added lifecycle and billing complexity.

## Bounded Render checks

Run against this revision using existing Render credentials; no deployment is requested. Every invocation has independent 15-second dry-run and execution bounds, a 20 GB billing cap, aggregate-only output and an external 40-second bound. Existing stage events report elapsed time from invocation start; actual execution duration is the difference between execution response/results and execution submission, not the cumulative elapsed value.

```bash
for stage in stages first-orders subsequent members aggregation full; do
  timeout 40s node diagnostics/oracle-classification-coverage.js \
    --as-of=2026-10-19T12:00:00Z --source=woo --store=ww --stage="$stage"
done
# Actual execution follows successful dry-run validation, never bypassing it.
for stage in stages first-orders subsequent members aggregation full; do
  timeout 40s node diagnostics/oracle-classification-coverage.js \
    --as-of=2026-10-19T12:00:00Z --source=woo --store=ww --stage="$stage" --execute
done
# Independent source results, including mature rows, coverage and partial delivery.
timeout 110s node diagnostics/oracle-cohort-providers.js --as-of=2026-10-19T12:00:00Z --execute
```

Compare successful stage counts and final cohort rows with the prior revision at the same cutoff; inspect SQL hash, job IDs and bytes alongside stage timings. Members includes window duplication, whereas aggregation counts cohort/window rows. These probes isolate reachable subgraphs, not additive costs or proof of BigQuery physical plans. A failed dry run stops that invocation before execution. Do not widen scope, retry indefinitely or interpret missing sources as zero.

## Workspace verification

BigQuery attempt: dry-run submission rejected HTTP 403 after 109 ms, no successful SQL validation and no actual execution. This is an access failure, not a query runtime or production improvement measurement.

Synthetic relational validation executes the generated SQL after BigQuery-to-DuckDB translation. It compares complete old/new Woo and Shopify result rows and independently asserts known mature denominators, repeats and classifications: alpha 90 days 1/1 mature (two entries including an immature entry); beta 90 days 0/1 and 180 days 1/1. It also executes every new probe. These are fixtures, not production counts or timings. BigQuery validation remains pending the bounded Render checks.

Local gates: acceptance 535/535 passed; browser acceptance passed all 21 conversations on desktop/mobile with durable refresh. The relational comparison also covers piece cohort grouping. Initial sandbox runs could not bind localhost; the gates passed with network permission for their local test servers.
