# One-off TikTok organic preservation: @thegreatfroglondon

## Actual acceptance on 7 October 2026

No live TikTok calls, no imported rows, no established historical coverage. `npm run probe:tiktok` exits `ACCESS_CONFIGURATION_MISSING`: neither `TIKTOK_ORGANIC_ACCESS_TOKEN` nor `TIKTOK_BUSINESS_ID` is configured. Google credentials are present, but read-only metadata calls for `gf-full-data.meta`, `oracle_ops` and `tiktok_organic` returned HTTP 403. Dataset locations could not be verified here. Fix warehouse/network access before import. These are blockers, not evidence of zero activity.

Branch base: latest GitHub `main` verified and then fetched at `40a68ca81d40a6a74d08dfe8b97a077ea17afbc0`. Existing `bigquery/client.js`, `bigquery/dataset-location.js`, Meta collection conventions, shared Oracle social provider/context, charts and owned XLSX exports are reused. No scheduler registration.

## Access setup

1. Use **TikTok API for Business → Organic / Accounts API**, not Ads Reporting or the Display API. Complete the Accounts API Access Application Form required for apps/scope increases including **TikTok Accounts** since 20 March 2026, and obtain production app approval. Configure the app's registered HTTPS OAuth redirect and verify the OAuth state on callback.
2. Request read permissions for **Account User** and **Get Account Media / insights**. The read scopes to request/verify in the approved Accounts app are `user.info.basic`, `user.info.username`, `user.info.profile`, `user.info.stats`, `user.account.type`, `user.insights`, `video.list`, `video.insights`. Portal labels and granted scopes must be checked against the app's current approved configuration; unavailable scopes do not become available merely by listing them in OAuth. Do not request publishing, comment management, messages or ads permissions for this collector.
3. Have the current owner of **@thegreatfroglondon** complete the Accounts app's account authorisation link while access still exists. Exchange the callback code using **`POST /open_api/v1.3/tt_user/oauth2/token/`**, with the approved app's `client_id`, `client_secret`, `auth_code` and documented grant configuration. This is a setup operation, not a content mutation. Use the current official OAuth instructions for the app; never paste tokens into terminal output or Git.
4. Securely bind the account token to **`TIKTOK_ORGANIC_ACCESS_TOKEN`**, and the token response's **`open_id`** to **`TIKTOK_BUSINESS_ID`**. This is the app-specific TikTok account ID, not a Business Center ID, advertiser ID, username or Display API ID. The collector verifies the returned username exactly before writes. Token expiry requires renewing through **`/tt_user/oauth2/refresh_token/`** or authorising again; securely retain `TIKTOK_CLIENT_ID`, `TIKTOK_CLIENT_SECRET`, `TIKTOK_REFRESH_TOKEN` if managing refresh outside this collector. The collector never reads those three optional refresh variables and fails clearly on expired credentials.
5. Reuse production **`GOOGLE_SERVICE_ACCOUNT_JSON`**, **`GOOGLE_PROJECT_ID`** or the existing ADC configuration. Grant the production identity dataset metadata/read, BigQuery job creation and additive table/schema/write permissions. Do not replace production credentials with a new login. Permit HTTPS to `business-api.tiktok.com`, Google OAuth/token hosts required by the configured identity, and `bigquery.googleapis.com` through the supported environment policy. GitHub access is needed to push the PR.

Primary sources inspected on 7 October 2026:

- [Official Accounts overview](https://business-api.tiktok.com/portal/docs/accounts-api-overview/v1.3)
- [Official Accounts approval notice](https://business-api.tiktok.com/gateway/docs/index?doc_id=1737565048641538&language=ENGLISH)
- [Official OAuth endpoint comparison](https://business-api.tiktok.com/gateway/docs/index?doc_id=1766037914914818)
- [TikTok-maintained profile request](https://www.postman.com/tiktok/tiktok-api-for-business/request/swn5ufv/business-user-get)
- [TikTok-maintained post/insights request](https://www.postman.com/tiktok/tiktok-api-for-business/request/7u65xdl/business-video-list)
- [Official app-specific open_id explanation](https://business-api.tiktok.com/gateway/docs/index?doc_id=1759977800177665)

Some current portal field descriptions were not publicly retrievable. Advanced fields and historical date semantics therefore remain **candidates requiring successful live endpoint evidence**, not verified capabilities. There is no live acceptance or assertion that all requested analytics are available.

## Exact commands

From the repository root, with securely injected variables:

```sh
npm run probe:tiktok
npm run preserve:tiktok -- --start 2016-09-01 --end 2026-10-06
npm run preserve:tiktok -- --execute --import-id greatfrog-preserve-20261007 --start 2016-09-01 --end 2026-10-06
```

The first command is a small read-only username/catalogue schema probe. The second is a dry plan. The third repeats the access probe then writes the one-off import. Repeat the **identical third command** after a transient failure; successful pages/fields/windows are skipped. Keep the same import ID and dates when resuming. Use a new ID only for an intentional new observation campaign; its snapshots remain separate. Each invocation has a 45-minute / 20,000-call budget. A very large import can require several invocations. A 6-hour warehouse lease protects writes, including each promotion; an interrupted process can require waiting for the lease to expire. Do not manually delete evidence or locks.

No post publication-date cutoff is applied, including posts older than a year. `2016-09-01` is a requested discovery floor, not a discovered retention boundary. Historical requests use non-overlapping windows of at most seven days, newest first. Rejections/empty responses do not establish a retention boundary. The collector does not infer an earlier account creation date or fabricate missing dates.

## Stored evidence and limits

`gf-full-data.tiktok_organic.observations` stores typed account/post ID, metric, unit, numeric value, native JSON, publication timestamp evidence, URL, requested/applied periods, timezone evidence, API version, endpoint, request ID, retrieval timestamp and import ID. `checkpoints` stores pagination completion, cursors, page/row counts, returned oldest/newest publication evidence and per-window availability. `collector_lock` serialises writers. The existing production `meta` dataset metadata supplies a new dataset's location; existing TikTok metadata always wins. Missing metadata permissions fail closed. No location is guessed.

- Profile identity/metadata, aggregate counters and current audience: each field is independently probed and preserved. `followers_count` current value is distinct from native dated follower evidence. Audience country/gender/age/activity fields are aggregate only.
- Catalogue: pagination without dates, stable `item_id`, caption and native publication evidence. URLs, thumbnails, media type/duration and remaining metadata are preserved by separate paginated field streams.
- Post analytics: views, likes, comments, shares, reach, watch time, completion, traffic sources, favorites/saves, audience, retention and other performance candidates each have an independent stream. A failure does not discard successful catalogue or metric streams. Availability is endpoint/account-specific; missing is not zero. Counts describe rows returned, and may include duplicate posts during a changing catalogue; evidence IDs deduplicate stored observations.
- Account history: the native aggregate plus **entire returned `metrics` container** is retained per requested field/window. Dated native buckets become `native_dated_observation` with applied dates. Undated/ambiguous totals stay `native_period_unverified`. API date clamping and timezone are not asserted when not evidenced. In particular, fields named `daily_*` are not automatically assumed to represent daily additive values. Native returned dates outside requested windows are preserved as evidence of applied coverage.
- Capability states distinguish `available`, `missing`, `inaccessible`, `unsupported_or_invalid_request`, `failed`. TikTok parameter error 40002 is deliberately not misreported as proof a metric is unsupported: it may be a date or schema issue. Unsupported fields and date limits require inspecting the current approved endpoint contract and rerunning with a new import contract if needed.

Writes are insert-only MERGEs in the same transaction as checkpoints; successful evidence is never replaced by a later failure. Retries are bounded for transport, 429, documented native rate-limit candidates and 5xx errors. Retry-After greater than one minute defers the run rather than ignoring the server's delay. No token, native error message, raw private exception, follower identity, commenter identity or DM is logged or collected. Only three fixed GET endpoints are allowed by the client; current collection uses two.

Oracle uses the shared request routing and social evidence service. Ask “Show TikTok follower trends in September 2026”, “Which TikTok posts had the most views this year?”, or “Show TikTok audience demographics this month”. XLSX requests use the existing owned download service. Native dated values support time-series charts; current post counters and aggregate demographic categories support bounded bar charts. The result discloses lifetime snapshots, unverified periods/timezone and incomplete coverage. No sales attribution or causal-impact route is added.

## Verification

```sh
node test/tiktok-preservation.test.js
npm test
npm run validate:oracle-tool-schemas
git diff --check
```

Fixture tests cover successful and malformed production-shaped pages, complete old-post pagination, identity mismatch, missing vs zero, native dated buckets, expired credentials, permission failures, rate limits/retries, pagination cycles, partial success, interrupted resume, idempotency and SQL transaction/location/lease fencing. Warehouse concurrency and BigQuery SQL have not received live acceptance because metadata access returned 403. Historical bounds and advanced metric contracts also remain unverified pending account access.
