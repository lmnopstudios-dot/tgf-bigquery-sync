# Accountant BigQuery quick-start

As of 12 October 2026. Audited repository: `eeb685631b2d609415a072d5520be0531a6bef4d` (GitHub main). **Repository-verified; deployed metadata, SQL dry runs and live coverage unverified.** Existing credential helper selected `gf-full-data`; metadata access failed first with sandbox `EPERM`, then with HTTP 403, `Could not refresh access token: Domain forbidden`, after network permission was enabled. This establishes a network/token-access limitation, not a BigQuery IAM finding. No transaction data was read.

Read [data dictionary and financial/join rules](accountant-data-dictionary.md), use [starter SQL and validation instructions](accountant-sql/README.md), and paste the [ChatGPT starter prompt](accountant-chatgpt-prompt.md). The SQL uses repository-defined or repository-consumed fields; it is not live-verified runnable SQL until the checks below pass.

1. Open [BigQuery Studio](https://console.cloud.google.com/bigquery?project=gf-full-data) and select the approved execution project.
2. Ask the warehouse owner for the dataset locations and deployed schema/view DDL. Use the schema discovery query independently in each dataset's location; never guess `US` or `EU`.
3. Agree the question, date basis, source/store, channel meaning and currency with ChatGPT. Supply the dictionary and schema metadata, not customer records.
4. Paste one SELECT into the editor. Check the validator's estimated bytes, set **More → Query settings → Maximum bytes billed** to an agreed cap (the repository finance service uses 5,000,000,000 bytes), and confirm GoogleSQL and processing location before running. `LIMIT` does not cap bytes scanned.
5. Return aggregate results, null counts and coverage caveats to ChatGPT. Keep currencies and source populations separate. Missing rows or fields are unavailable evidence, not zero.

## Required access (owner performs; this handover changes no IAM)

Minimum for ledger-only review: `roles/bigquery.jobUser` on the execution project and `roles/bigquery.dataViewer` on **approved accountant views in `gf-full-data.finance`**. Start with `accountant_transactions`; optional monthly, annual, location and gift-card views need deployed DDL/schema review first. `sales_master` is an upstream authority reference, not automatically a required user grant.

Oracle canonical finance reconstruction additionally requires read access to `shopify_data.order_financials`, `order_locations`, and `order_refunds`, plus the non-Shopify rows of `finance.accountant_transactions`. Operational Woo checks optionally require `metorik_uk.orders`, `order_line_items` and their `metorik_us` counterparts. Optional Square operational checks use the customer-free `square_data.retail_*` views; do not grant raw Square/customer datasets merely for ledger review. `woocommerce_uk`, `woocommerce_us`, `woocommerce_jp` and `oracle_knowledge` are owner/auditor escalation sources, not default accountant grants.

Console setup:

- Execution project: **IAM & Admin → IAM → Grant access**; enter the accountant's identity; choose **BigQuery Job User**; save. Use the selected query project, which pays for jobs. Do not grant Editor, Admin or Data Editor.
- Dataset: **BigQuery Explorer → dataset → Sharing → Permissions → Add principal**; choose **BigQuery Data Viewer**. Dataset scope exposes all permitted objects in it: review sensitivity before granting. For an approved view only, select the view's sharing/permissions controls and grant table/view read access under the organisation's supported IAM policy, rather than blanket access to raw datasets.
- An ordinary logical view still requires reader access to its underlying objects. An **authorised view** can allow view-only access if the source dataset already authorises that exact view. The owner must inspect dataset access entries and the dependency chain; the word “accountant” does not prove authorisation or PII restriction. Without existing authorisation, underlying read access is required. Do not create views or change authorisations as part of this task.

Financial JSON, raw Woo payloads, customer IDs/names, customer notes, address/geography fields and transaction identifiers may be sensitive. Existing Square semantic views omit customers; accountant-view columns and raw JSON must still be reviewed live. Do not paste customer data or credentials into ChatGPT.

## What the figures can establish

The accountant ledger and Oracle canonical finance are distinct contracts. Canonical finance replaces every Shopify-labelled legacy ledger row with eligible native Shopify order/refund evidence in presentment currency. Annual/location accounting reads the ledger directly. Neither query establishes bank settlement, VAT payable, or complete collection. November 2025 Woo/Shopify online components have no accepted business-wide reconciliation contract; retain legitimate overlap and withhold combined online comparison claims.

## Exact remaining read-only checks

1. In an authorised runtime using `bigquery/client.js`, get metadata for each required dataset and named object. Record location, schema, type, view SQL, partitioning, last modification and existing authorised-view access/dependencies. Include finance summary/gift-card DDL; their definitions are absent here.
2. Inspect deployed `finance.sales_master` and `accountant_transactions` DDL for Woo/Square status, tax, gift-card, refund-deduplication and timezone transformations. Resolve the documented Square component disagreement against matching provider-native reports; do not infer VAT from a rate.
3. Dry-run each starter SELECT in its metadata-derived location, using the supplied explicit dates. Record bytes and errors; execute no large scans. Multi-dataset canonical statements require co-location.
4. Run the aggregate identity check before canonical joins. If duplicates appear, stop; this canonical CTE does not implement revision deduplication. Compare native Shopify source components with the canonical CTE and separately with legacy Shopify ledger rows under identical occurrence windows and presentment currencies.
5. Run bounded coverage/freshness aggregates only after cost review. Verify order/refund evidence dates separately from `synced_at` and successful refresh watermark. Compare missing intervals with source reports; maxima are not completeness.
6. Review November 2025 source/channel/currency components, Matrixify exclusion and pre-launch native rows against source-native reports and owner-approved migration mapping. Public launch is 20 November; no hard cutoff is implemented. Obtain accepted population reconciliation before combined online claims.
7. Confirm any fees/payout/bank evidence separately: no supported payout reconciliation schema was established. Confirm Woo/Square retirement dates with the owner; do not restart collection.

No collection, backfill, inventory query, mutation, schema/IAM/schedule change, deployment or merge was performed. Documentation and SQL examples are the only deliverables.
