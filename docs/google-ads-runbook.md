# Google Ads reporting runbook

## Contract and safety

This is a **read-only reporting integration**. It only calls `GoogleAdsService.SearchStream` with GAQL `SELECT` statements. It has no mutate, budget, upload, conversion-upload, campaign-management or account-settings path.

The reviewed contract on 2 October 2026 is Google Ads API **v22**. Google sunset developer tokens on 9 September 2026; new access is approved against the Google Cloud project. Consequently this implementation does not request or send a developer token. Re-check the [release notes](https://developers.google.com/google-ads/api/docs/release-notes), [access model](https://developers.google.com/google-ads/api/docs/get-started/dev-token), [service-account guide](https://developers.google.com/google-ads/api/docs/oauth/service-accounts), [REST SearchStream reference](https://developers.google.com/google-ads/api/rest/reference/rest/v22/customers.googleAds/searchStream), [GAQL compatibility](https://developers.google.com/google-ads/api/fields/v22/overview_query_builder), [rate limits](https://developers.google.com/google-ads/api/docs/best-practices/quotas), and [data retention](https://developers.google.com/google-ads/api/docs/reporting/criteria-metrics) before changing the pinned version. The old page URL may retain “dev-token” in its path even though the post-sunset approval workflow is Cloud-project based.

Authentication project identity (`GOOGLE_ADS_AUTH_PROJECT_ID`, expected to be `gf-full-data` only after review) is intentionally independent from destination `GOOGLE_PROJECT_ID`. The same service account may be used only if it is explicitly granted access to both Ads customers and already has the required BigQuery role. An MCC is optional. `login_customer_id` is supplied per account only when the service account reaches that customer through a manager.

## Exact access/configuration checklist

1. Obtain, without inventing, both ten-digit Ads customer IDs and human-reviewed display names.
2. Select a Google Cloud authentication project, enable Google Ads API, and complete its production-access approval. Record project ID and approval evidence. Do not create credentials in this program.
3. Add the service-account email to **each** Ads account (directly, or through the reviewed manager) with the minimum read/reporting-only role. Verify each account independently. Never grant campaign-management permissions merely for this collector.
4. If a manager is used, obtain its ten-digit ID and set that account's `login_customer_id`; otherwise use `null`. An MCC is not assumed or required.
5. In every Render service/cron (environment is not inherited from the web service), set:
   * `GOOGLE_ADS_ACCOUNTS_JSON` — exactly two records (example shape below), with neither account automatically active.
   * `GOOGLE_ADS_AUTH_PROJECT_ID` — API-enabled, approved authentication project.
   * `GOOGLE_ADS_SERVICE_ACCOUNT_JSON` — optional separate Ads credential; otherwise `GOOGLE_SERVICE_ACCOUNT_JSON` is used. Never log either value.
   * `GOOGLE_ADS_API_VERSION=v22`.
   * `GOOGLE_PROJECT_ID` and `GOOGLE_SERVICE_ACCOUNT_JSON` — BigQuery destination and credential.

```json
[
  {"customer_id":"REPLACE_WITH_FIRST_10_DIGIT_ID","display_name":"Reviewed first account name","collection_status":"historical_only","history_start":"YYYY-MM-DD","history_end":null,"timezone":"REVIEW_AFTER_DISCOVERY","currency":"REVIEW_AFTER_DISCOVERY","login_customer_id":null},
  {"customer_id":"REPLACE_WITH_SECOND_10_DIGIT_ID","display_name":"Reviewed second account name","collection_status":"historical_only","history_start":"YYYY-MM-DD","history_end":null,"timezone":"REVIEW_AFTER_DISCOVERY","currency":"REVIEW_AFTER_DISCOVERY","login_customer_id":null}
]
```

Allowed status is `historical_only`, `active`, or `disabled`. Paused campaigns do not stop an `active` account. Do not mark either account active until the business selects it. Discovery-returned timezone/currency must match the reviewed config before broad collection.

## Production execution order

All dates are inclusive account-local reporting dates.

```bash
# 1. configure access and all variables above in the target Render service
# 2. bounded, read-only access/metadata/history probe for both accounts
npm run discover:google-ads -- --start 2026-08-01 --end 2026-08-31
# 3. reviewed sample, separately for each real ID
npm run collect:google-ads -- --start 2026-08-01 --end 2026-08-07 --customer CUSTOMER_ID --chunk-days 7 --max-chunks 1
# 4. API/account/campaign/persistence/actual Oracle read-path reconciliation
npm run reconcile:google-ads -- --start 2026-08-01 --end 2026-08-07 --customer CUSTOMER_ID
# 5. bounded resumable history; repeat exact next/resume commands emitted by failures
npm run collect:google-ads -- --start REVIEWED_EARLIEST_EVIDENCE --end REVIEWED_END --chunk-days 31 --max-chunks 24
# 6. manual wrapper test (only explicitly active accounts are refreshed)
npm run collect:freshness -- google_ads
# recovery/scheduled evidence
npm run collect:freshness -- google_ads --recovery-check
# 7. deploy the render.yaml cron, then verify a real scheduled run (run_mode/scheduled_execution)
```

Do not run a broad backfill before both discovery outputs and samples are reviewed. A per-account failure exits nonzero while retaining atomically promoted windows from the other account. Coverage rows are written even for zero activity, so zero, failed, missing and unattempted windows remain distinguishable. Exact resume commands are included in failure output.

## Reporting semantics and acceptance

Campaign daily grain is customer/date/campaign. Account controls are customer/date. Conversion actions are separate because segmentation can change populations and would duplicate spend if joined naïvely. `cost_micros` is exact `NUMERIC`; conversion counts/values remain fractional `NUMERIC`. CTR = clicks/impressions, CPC = spend/clicks, CPM = spend × 1000/impressions, cost/conversion = spend/primary conversions, and ROAS = Google-attributed conversion value/spend. `conversions` means primary actions included in the Conversions column; `all_conversions` stays separate. Only a conversion action categorized by Google as `PURCHASE` may be called purchase evidence.

These queries use **interaction-date** semantics. Conversion-date reporting is not mixed in. Late attribution may revise live values. Scheduled overlap is the reviewed conversion window plus seven days, bounded to 14–90 days; current overlap defaults to 37 days. Recent results are provisional. Attributed values are neither finance sales nor incremental revenue, must not be added to finance/Klaviyo/Meta, and are not cross-platform deduplicated.

For acceptance, reconcile the same customer, dates, account timezone, currency, status filters and conversion definitions across (1) direct account API, (2) campaign API sum, (3) persisted control/campaign rows, and (4) the Oracle query. Separately export the identical report from the Google Ads UI: record export time, customer, timezone, interaction-date selection, columns, campaign filters and conversion settings. UI/API drift caused by attribution changes is different from warehouse/Oracle inconsistency.

SearchStream responses are fully consumed and rejected if malformed or beyond call (100), row (250,000), or duration (120 seconds) bounds. HTTP 429/5xx responses retry with bounded exponential/`Retry-After` guidance. BigQuery uses load jobs into expiring staging tables and a transaction for replacement plus coverage. Individual DML shapes are dry-run; BigQuery does not guarantee full validation of every later statement in a multi-statement dry run, so the runbook does not claim otherwise.

Known limitations: API retention/access determines “all accessible history”; account creation is not inferred from first activity; removed campaign visibility and conversion settings depend on API retention and permissions; live credentials, production approval, actual earliest evidence, dashboard agreement, Render scheduling and both real account identities remain unverified until the sequence above completes.
