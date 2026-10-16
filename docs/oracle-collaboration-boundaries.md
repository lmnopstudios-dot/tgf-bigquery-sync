# Collaboration piece cohort boundary repair

Based on latest origin/main b0f0412, including merged #329 (805e8e9) and #330. The original checkout was clean; existing retention infrastructure and monthly-country, basket and campaign paths are retained.

Demonstrated locally on that base: the exact production prompt already resolves 2023-10-16 through 2026-10-16 at runtime 2026-10-16 Europe/London, including the disclosed current-day cutoff. Its date question is not reproduced on this revision. It does narrow `online and instore` to in-store, because two independent assignments overwrite the channel. It also forces collaboration-name grouping, losing individual pieces. Neither observation establishes the cause of the correlated production exception.

The retention context now preserves simultaneous channels, piece versus collaboration grouping, most-returning-customer versus repeat-rate intent, first-observed history and pending dates. Ordinary relative years share the calendar resolver across subjects; numeric/spelled counts, completed years, invalid bounds and leap-day clamping have coverage. No production-phrase date exception was added.

The production dependency factory still binds the existing customer-journey service. Its additional `retention_product_windows` projection groups by source-qualified entry product reference, independent of historical titles. Only governed collaboration classifications and existing approved classification propagation qualify. Source-qualified identities sequence available eligible history before the entry filter; Matrixify migration exclusion is preserved. Outcomes are any eligible subsequent purchase, not same-collaboration repurchases. Entry dates and observation end remain separate contract fields. Mature 90/180-day counts, sample sizes, exact conditional medians, source boundaries and non-causal wording remain in the table.

For an explicitly combined request, Woo and Shopify reads run separately under one 45-second waiting deadline, at most 20 GB billed per SQL read, with at most 25 entry groups / 50 output rows per read and 100 combined rows. A failed source retains the other source's validated aggregate. There is no retry or fallback sales report. Per-source truncation is disclosed. Source selection is bounded lexically; this remains a ranking among retrieved cohorts rather than proof of a complete global winner.

Combined WooCommerce/Square/Shopify customer linkage has **not** been implemented. No governed cross-source identity bridge is persisted. Square and anonymous POS are outside this provider; unidentified Woo/Shopify orders are excluded. Supported source cohorts must not be added into a company-wide cohort. The unevaluable customer count and share are explicitly unknown because no complete governed denominator is available. Available-history lookback is used, but history completeness is unverified; first-ever purchase cannot be claimed and left-censoring is disclosed. Order-date SQL retains the existing disclosed UTC convention; relative-period endpoints use runtime Europe/London. Cohort XLSX/CSV/chart exports remain unsupported with a precise limitation; supported monthly-country and other export regressions remain in the gates.

Scope travels through analysis-context → analysis-decision/capability registry → analytical plan → route dispatcher → baseline capability binding → real dependency factory → journey SQL → retention row validation → operation/period/channel/grouping/identity validation → shared terminal result contract. The same evidence contract guards direct agent results, interactive responses, lease-owned durable persistence, authenticated polling and browser refresh. Recovery performs no provider read. The persistent matrix includes the exact production wording fresh, after unrelated sales, and followed by “Last 3 years.” A no-date variant and an explicit pending-context test preserve requirements across date clarification.

## Bounded live investigation and Render commands

No Render API key/service binding or Render log connector is available. The correlation lookup and both collaboration/piece SQL dry runs were attempted with existing credentials. Each failed with HTTP 403 at Google token acquisition (`oauth2.googleapis.com`) before any BigQuery execution. No production job row, exception, deployed revision, SQL/schema validity or coverage was verified. The generic UI rejection is not evidence of a particular exception.

Run these exact read-only commands in Render with its existing identity; they require no deployment, source write, collection or permission change:

```sh
node diagnostics/oracle-correlation-read.js
node diagnostics/oracle-cohort-retention-read.js
node diagnostics/oracle-cohort-retention-read.js --pieces
```

The first selects only status, error code, attempts, timestamps and failed stage for request `a25426d9-3443-4d02-8e8a-3325953f567e`: at most 5 rows, 100 MB billing cap, 15-second warehouse timeout. It never reads prompt/answer/owner fields. No match does not rule out an interactive or pre-job failure. The latter probes are dry runs only, each with a 30-second job timeout and 20 GB cap; they do not execute result reads. Capture the deployed revision and at most 100 sanitized Render stage-log lines matching the exact correlation ID, preserving stage/code/provider status and timestamps. Omit prompts, customer data, credentials and raw provider bodies. Those logs plus job status are the missing evidence needed to establish the production failure.

## Validation

Acceptance gate: 433 passed, zero failures/cancellations/skips (18 conversations, 21 regression suites). Final focused cohort/matrix check after the scope audit: 76 passed. Browser: 18 conversations passed on desktop/mobile with durable refresh. Strict schemas: 46 across 61 tools. Repository suite completed with 1,460 passed, 3 opt-in live checks skipped, zero failures; a final repository rerun is recorded separately in the PR. Initial acceptance: 426/427 passed; the new winter-midnight fixture incorrectly expected British Summer Time in February and was corrected. Initial browser command could not resolve its default module; the existing `/opt/codex/cua_node/lib/node_modules/playwright-core/index.mjs` and `/usr/bin/chromium` then passed all 18 conversations on desktop/mobile including durable refresh. No package was installed. Fixture provider results validate shared dispatch/delivery and aggregate arithmetic; they do not certify live SQL results or warehouse history completeness.
