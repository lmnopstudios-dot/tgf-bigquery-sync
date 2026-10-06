# November online comparison: read-only acceptance

The sales explanation leads with currency-separated canonical finance components and the unknown business-level online result. November 2025 spans the Woo-to-Shopify migration and the confirmed public launch on 20 November. Woo-only year-on-year change must not become an overall online-performance headline.

`orders` remains a legacy finance API identifier; it means finance sale transaction count. The report additionally exposes `sales_transaction_count`. Neither is relabelled as distinct ecommerce orders. Canonical accounting refunds remain separate from operational order-cohort refunds and source-native eligible-order counts.

The current governed finance path preserves non-Shopify ledger history and native Shopify transactions, including legitimate overlap, but supplies no accepted migration reconciliation contract. Overall online comparisons are therefore withheld even within one currency. Source components and both requested periods remain available. Migration-period headline KPI deltas are withheld; underlying current and comparison rows remain intact.

Default tables contain currency/source components and concise observed-day coverage. Observed dates do not establish collection completeness. Daily provenance is available in collapsed supporting evidence. Shopify evidence before 20 November, including 18 November if returned, is retained and flagged for investigation. Same-day Woo/Shopify evidence is not proof of duplication. No launch cutoff or date deletion is applied.

Both periods retrieve confirmed context independently with a 14-day look-behind, plus an independent event-only search so undated general records cannot crowd out campaigns. Event content comes from governed services, not embedded campaign text. Failed or empty retrieval means unknown campaign context, not no campaign.

Run the bounded existing-data diagnostic:

```bash
node diagnostics/november-migration-comparison.js
```

It retrieves the exact supplied 2024 event `ev_d62be9ed-527e-403a-a661-cb2d11095ca5`, both periods' context, and canonical finance source components/overlap. It performs no collection, backfill, proposal write, schedule change or source mutation. Inspect the event's confirmation, dates, content and provenance; inspect November 18 Shopify rows against November 20 launch, source/channel eligibility, refund-date definitions and overlap. Aggregate overlap cannot settle duplicate identity or grant population acceptance.

During this change, all three live diagnostic operations returned HTTP 403 after permitting network access in the execution sandbox. Live event content and finance populations remain unverified here; fixture regression success is not production acceptance.

Regression checks:

```bash
node --test test/oracle-general-analytics.test.js test/report-v2.test.js test/oracle-markdown.test.js test/oracle-baseline-overview.test.js test/canonical-finance.test.js
```
