# Klaviyo email reporting runbook

## Safety and semantics

This integration is read-only. Never grant write scopes, send messages, change flows/campaigns or attribution settings, or access profiles. Klaviyo attribution is kept separate from Shopify session-referrer reporting and from canonical Shopify/Woo finance sales. Attributed conversion value is neither incremental revenue nor an amount to add to finance totals. Campaign and flow rows, email and SMS, currencies, and conversion metric IDs remain separate. Opens include privacy/machine activity under Klaviyo's reporting behaviour and must be qualified.

The implementation uses the current JSON:API report endpoints (`POST /api/campaign-values-reports` and `POST /api/flow-values-reports`) and metadata endpoints (`GET /api/campaigns`, `/api/flows`, `/api/metrics`). Before deployment, compare the pinned revision with the official [Klaviyo API versioning policy](https://developers.klaviyo.com/en/docs/api_versioning_and_deprecation_policy), [reporting API guide](https://developers.klaviyo.com/en/docs/using_the_reporting_api), and endpoint reference. `KLAVIYO_API_REVISION` is mandatory so a revision is never invented silently.

## Render configuration and least privilege

Create a **private API key** in Klaviyo with only `campaigns:read`, `flows:read`, and `metrics:read`. Store it as a secret Render environment variable named `KLAVIYO_PRIVATE_API_KEY`. Also set:

* `KLAVIYO_API_REVISION` — an official, supported `YYYY-MM-DD` revision verified at rollout.
* `KLAVIYO_ACCOUNT_TIMEZONE` and `KLAVIYO_ACCOUNT_CURRENCY` — values copied from the account/dashboard. The API probe does not invent either.
* `KLAVIYO_CONVERSION_METRIC_IDS` — comma-separated stable IDs selected after discovery; keep Shopify and WooCommerce “Placed Order” IDs distinct.
* `KLAVIYO_MAX_API_CALLS=40`, `KLAVIYO_TIMEOUT_MS=15000`.
* `KLAVIYO_DISCOVERY_MANIFEST` — local path to the reviewed gate JSON for pilot collection.
* Existing `GOOGLE_PROJECT_ID` and `GOOGLE_SERVICE_ACCOUNT_JSON` for collection only.

The client redacts authorization values and never emits response bodies on errors. Discovery output contains aggregate counts, stable IDs, names/integration provenance, and report row counts—not profiles or customer-level events.

## Phase 1 — mandatory discovery gate

Run this exact first command in Render Shell (it is read-only and bounded to eight pages per listing, 1,000 items, 40 calls, three retries, and 15 seconds per call):

```sh
npm run discover:klaviyo > /tmp/klaviyo-discovery.json
```

Review metric IDs and integration provenance. Confirm August 2026 probe availability. In a protected copy of the JSON, record the dashboard's exact attribution settings in `attribution_settings` and change `approved_for_pilot` to `true`; retain reviewer/time externally or in the change record. If settings are unavailable, stop. Do not guess them. Store the approved file durably and set `KLAVIYO_DISCOVERY_MANIFEST` to its path. The fingerprint makes the original discovery evidence reviewable; editing it is an explicit approval action.

## Phase 2 — August pilot only

```sh
npm run collect:klaviyo-pilot
node diagnostics/klaviyo-production.js
```

Collection is hard-coded to the August 1–September 1 exclusive report timeframe. It stages then atomically `MERGE`s on report kind, entity/message ID, window, and conversion metric ID, so retries are idempotent. A partial endpoint failure promotes nothing. Evidence has seven-year partition retention. Broad historical backfill is intentionally not implemented; approve one only after acceptance.

## Dashboard acceptance

For each chosen conversion metric ID independently, export/view Klaviyo campaign and flow reports with **August 1–31 2026**, the recorded timezone/currency, identical attribution window/settings, and email channel. Reconcile recipients/delivered, unique clicks, opens, bounces, unsubscribes, spam complaints, conversions and conversion value. Document dashboard export time, settings, metric ID and discrepancies. Differences must be explained as report population, message/report-window semantics, late attribution, privacy/machine opens or dashboard freshness—not forced to equal Shopify finance totals. Confirm click rate is unique clicks ÷ delivered and revenue per delivered is conversion value ÷ delivered where both compatible inputs exist.

The production diagnostic calls the same `collectPilot` and Oracle service helpers, performs no writes, and reports errors rather than zeros. A local run without production credentials is **not** live verification.

## Oracle coverage

Oracle exposes bounded tools for period performance, click/purchase opportunity ranking, and Klaviyo-versus-Shopify email-referrer comparison. Results include volumes beside rates, stored coverage, metric/currency/timezone/revision/settings, and limitations. Shopify referrer traffic is side-by-side only; it cannot establish all email influence or campaign-level device/session joins. Tool results remain structured evidence if answer synthesis fails.
