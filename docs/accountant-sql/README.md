# Starter GoogleSQL

As of 12 October 2026; audited main `eeb685631b2d609415a072d5520be0531a6bef4d`. [Quick-start](../accountant-quick-start.md) · [dictionary/rules](../accountant-data-dictionary.md) · [prompt](../accountant-chatgpt-prompt.md).

**All statements are unverified live.** Field references were checked against repository schemas/consumers; canonical CTEs are copied exactly from `finance/canonical.js` with the existing Matrixify constant substituted. No dry run succeeded: configured credentials could not refresh through the network policy (403 Domain forbidden). No data SELECT or large scan ran. These statements are intended runnable against matching deployed schemas, not evidence that those schemas exist. Do not repair errors by guessing fields.

| File | Purpose / metric and eligibility | Expected grain / limits | Processing location |
|---|---|---|---|
| [01 schema discovery](01-schema-discovery.sql) | Metadata columns/types and view definitions; no transaction rows | One column/object or view/object. Replace dataset identifier and table list for each approved dataset; no claim about coverage. Metadata has no transaction date bounds | Each dataset's actual location separately |
| [02 monthly canonical](02-monthly-canonical.sql) | November 2025 occurrence components using exact canonical eligibility; signed after-discount tax-inclusive sales/refunds, stored ex-tax and tax | Month/source-label/channel/currency/provenance; Shopify source has no separate store. Null-aware aggregates added without changing canonical populations. Collector zero defaults and refund-tax COALESCE remain. No combined online claim | `finance` and `shopify_data` must be co-located; use that location |
| [03 refund occurrence](03-refund-occurrence.sql) | November refund-date totals; native Shopify refund_created_at UTC and legacy ledger date | Month/source/channel/currency/provenance. Negative refund amounts; count is rows, assuming unique identities. Distinct order count covers native Shopify only. Legacy timezone/dedup unknown | Same co-location as 02 |
| [04 channel/ledger components](04-channel-ledger-components.sql) | November accountant ledger channel/location components; all sale/refund rows under ledger policy | Month/source/channel/location/currency/type. Sum all component rows under identical currency/source predicates to check channel-vs-location population differences. Preserves Unknown and stored discrepancy; does not prove canonical/native equality, online completeness or VAT | `finance` actual location |
| [05 coverage/freshness](05-coverage-freshness.sql) | September 2026 native order/refund occurrence cohorts, all statuses; separate collector state | Evidence-kind/currency, then collector. Missing cohort gives no row, not a zero/completeness claim. Synced_at maxima do not prove current collection; update watermark includes old orders and is different from sale-date coverage | `shopify_data` actual location |
| [06 identity check](06-identity-check.sql) | Aggregate duplicate/null-key precondition for direct canonical joins | Object-level counts across full key space; no date filter because duplicates may cross windows. Requires explicit scan cost review; no dedup mutation | `shopify_data` actual location |

02/03 use intentionally separate source/store labels: native Shopify's single configured shop is implicit, while legacy source labels carry store information. Do not invent `source_store` on finance objects or force currencies from store names. 04 is a reconciliation worksheet, not a supported bridge between incompatible operational and ledger populations.

## Cost and syntax validation for every query

In BigQuery Studio select GoogleSQL and the metadata-derived processing location. Paste one SELECT (01 and 05 contain two separate SELECTs; validate them individually). Before Run, inspect the validator's estimated bytes. Set maximum bytes billed under Query settings to an agreed cap; it prevents excess billing but is not a coverage guarantee. Views can scan underlying tables, and LIMIT does not reduce scanned bytes. A 5 GB cap matches the canonical service; use a smaller cap if sufficient. Do not run a costly identity scan merely because it is in this handover.

Owner validation with the existing helper, from repository root (substitute the actual location and filename; no source writes):

```js
import { readFileSync } from 'node:fs';
import { createBigQueryClient } from './bigquery/client.js';
const { bigquery } = createBigQueryClient();
const [metadata] = await bigquery.dataset('finance', { projectId: 'gf-full-data' }).getMetadata();
const query = readFileSync('docs/accountant-sql/02-monthly-canonical.sql', 'utf8');
const [job] = await bigquery.createQueryJob({ query, location: metadata.location,
  useLegacySql: false, dryRun: true, maximumBytesBilled: '5000000000' });
console.log({ valid: true, estimatedBytes: job.metadata.statistics.totalBytesProcessed });
```

First verify all dependencies' locations. Dry runs validate syntax/field references and estimated cost, not data uniqueness or accounting policy. Record individual statement result/date/location/bytes, then obtain aggregate data only when cost is acceptable.

## Payments and payouts

No verified settlement/payout/fee table or complete bank reconciliation contract is available. Therefore no payout query is supplied. Shopify transactions_json contains `id`, `kind`, `status`, `gateway`, createdAt/processedAt and paired `amountSet` shopMoney/presentmentMoney money values; use metadata and a bounded owner-reviewed extraction before payment queries. Transactions require ID uniqueness and currency/status separation. Successful SALE/CAPTURE counts and amounts must not be substituted for canonical order totals. Optional Square retail_payments excludes fees/payouts and has unverified units/statuses. A source report or bank report is needed to reconcile received money to deposits.
