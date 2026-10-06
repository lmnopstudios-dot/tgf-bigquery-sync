# Meta and Instagram evidence

## What was found and what is verified

The repository already has Google Ads and Klaviyo collectors, staged BigQuery promotion, `oracle_ops` run/state governance, Render cron conventions, a shared Oracle provider factory, deterministic scope/dispatch, charts, and private durable workbook storage. It has no existing Meta advertising or Instagram insights collector. Historical Google Ads customer IDs are not Meta account IDs. Existing Facebook/Instagram commerce source labels are referrer classifications, not advertising or organic-post attribution.

The current task environment does not configure `META_API_VERSION`, `META_AD_ACCOUNTS_JSON`, `INSTAGRAM_ACCOUNTS_JSON`, `META_ACCESS_TOKEN`, or `INSTAGRAM_ACCESS_TOKEN`. No connected Meta/Instagram account IDs, currencies, timezones, tokens, permission grants, earliest accessible insights dates or media-type capabilities have been verified. No live import, production schedule, deployment, source mutation, inventory collection or knowledge write was performed. Production BigQuery execution of the new DDL/DML remains unverified; fixture tests validate its request/transaction contract, not live syntax or IAM.

The implementation adds one collector family, not a second Google Ads integration. `meta/cli.js` owns diagnostics, bounded ads backfill, attribution refresh and Instagram snapshots. `ops/collector-runner.js` dispatches both scheduled sources through the same CLI. All warehouse collection paths enter existing `oracle_ops` governance and a shared singleton row lock, which prevents concurrent Meta/Instagram backfill/scheduled runs through transaction conflicts. The append-only ledger by itself is not a sufficient mutex. No active services are added to `render.yaml`; `meta-instagram-render.yaml` is a proposal only.

## Access setup

Configure the following through the existing secure runtime/Render environment mechanism. Never put token values in configuration JSON, repository files, command arguments, URLs, PRs or diagnostic output.

- `META_API_VERSION`: an explicitly reviewed, supported Graph version. There is no assumed default. Test fixtures use `v25.0`; this is not a declaration of the current supported production version. Check Meta's version schedule, SDK and the actual app before setting it.
- `META_AD_ACCOUNTS_JSON`: reviewed numeric ad account IDs, native currency/timezone, status, token environment name, historical bounds, exactly one purchase action, action reporting time and refresh window. Use the numeric ID without `act_`; the client adds that prefix.
- `INSTAGRAM_ACCOUNTS_JSON`: reviewed professional account IDs, authentication path, timezone and metric profiles separately for account, image, carousel, Reel, video and Story. Account IDs must belong to the selected app/token path.
- Secret environment values named by `token_env`, for example `META_ACCESS_TOKEN` and `INSTAGRAM_ACCESS_TOKEN`. The collector uses bearer headers and never logs upstream error bodies, tokens or token-bearing next URLs.
- Existing `GOOGLE_PROJECT_ID` and `GOOGLE_SERVICE_ACCOUNT_JSON`, with permission to create/read the `meta` evidence dataset, stage/load tables, transact DML, and read/update the `oracle_ops` control dataset. Oracle needs read access; existing export storage remains in `commerce`.
- Runtime network access to `graph.facebook.com`, and to `graph.instagram.com` for Instagram Login, plus the existing Google/BigQuery endpoints. These Meta hosts are not in the task environment's network-policy allowlist. Configure access through the supported environment configuration workflow; do not bypass the proxy.

Meta advertising needs a business/app identity assigned to each account with read access and the appropriate `ads_read` grant. Do not request ad management for this collector. Review app mode, advanced access, business verification and account asset assignment for the intended business/user/system-user token. Async Insights POSTs create read-only reports; all other Graph writes are rejected by the client.

For **Facebook Login**, connect the professional Instagram account to its reviewed Facebook Page and use the applicable Instagram Insights and Page access grants (`instagram_basic`, `instagram_manage_insights`, and the Page grants needed for discovery/access, commonly `pages_show_list` and `pages_read_engagement`). For **Instagram Login**, use the professional account's Instagram token and review `instagram_business_basic` and `instagram_business_manage_insights`. Scope requirements vary with app/token path; confirm current grants in the app and run the bounded Insights probe. Do not enable private message permissions. An identity read alone does not prove Insights permission.

No credential broker/refresh flow for Meta already exists in this repository, and this change does not invent one. Record the token owner, issuing app, granted scopes, expiration/data-access expiration, asset assignment and renewal procedure in the approved secret-management process. Inspect token status with Meta's debugger outside log output; rotate the configured secret before expiration and repeat bounded diagnostics after rotation. Invalid/expired tokens and denied permissions fail closed with sanitized codes. The collector does not attempt interactive login or refresh unsupported token types.

Configuration shapes (replace all placeholder IDs/version and confirm native metadata; these are not known TGF accounts):

```json
[
  {
    "account_id": "REVIEWED_META_ACCOUNT_ID",
    "display_name": "Reviewed account",
    "collection_status": "historical_only",
    "timezone": "REVIEWED_IANA_TIMEZONE",
    "currency": "REVIEWED_NATIVE_CURRENCY",
    "token_env": "META_ACCESS_TOKEN",
    "history_start": "2024-01-01",
    "history_end": null,
    "purchase_action_type": "omni_purchase",
    "action_report_time": "conversion",
    "refresh_days": 35
  }
]
```

The example purchase action/reporting time requires explicit review against the account's native actions. Select exactly one action; `purchase`, `omni_purchase` and pixel purchase aliases are never added together. Explicit `attribution_windows` can be configured instead of unified ad-set attribution. Windows are validated and passed unchanged; inspect actual native action/window responses. Current ad-set attribution specifications and creative destinations are observations, not proven historical settings. Distinct selected action/reporting-time/API/window/native ad-set contracts remain separate in Oracle.

```json
[
  {
    "account_id": "REVIEWED_INSTAGRAM_ID",
    "display_name": "Reviewed professional account",
    "collection_status": "historical_only",
    "timezone": "REVIEWED_NATIVE_BUCKET_TIMEZONE",
    "token_env": "INSTAGRAM_ACCESS_TOKEN",
    "auth_path": "facebook_login",
    "history_days": 1,
    "account_profiles": [],
    "media_profiles": {"IMAGE": [], "CAROUSEL_ALBUM": [], "REELS": [], "VIDEO": [], "STORY": []}
  }
]
```

Profiles are **reviewed probe candidates**, not promises of availability. A profile has `metric`, `period`, `metric_type`, `evidence_kind`, optional aggregate `breakdown`, and optional native `timeframe`. Use current account/media documentation and the actual configured version. For example, after confirming support, an image `saved` lifetime profile can use `{"metric":"saved","period":"lifetime","metric_type":"time_series","evidence_kind":"lifetime_total"}`. `profile_activity` with a supported `action_type` breakdown can retain profile/link interaction categories. Reel watch-time metrics may be added through the same profile contract. Audience demographic metrics require their supported period/timeframe and aggregate breakdown; they never retrieve audience members. Do not copy deprecated impressions/video-view metrics from old examples.

Discovery probes every configured account profile and one available sample of each configured media type from the first 25 media/Stories. Unsupported/missing samples remain unverified; discovery is not exhaustive historical validation. Collection paginates the complete media/Story edges within budgets and probes each profile against each media item. Unsupported metric/media requests become explicit `unsupported_or_unavailable` observations. Permission, pagination and transport failures fail collection. Account-total follower snapshots are collected independently of profile candidates.

## Evidence contracts

| Dataset/table | Grain and interpretation |
| --- | --- |
| `meta.ad_daily` | Native daily ad rows: IDs/names, native currency/timezone, spend, impressions, clicks, link/outbound clicks, landing-page views, one purchase action count/value, raw actions/value arrays, API/requested dates, reporting time, attribution contract/settings and retrieval timestamp. |
| `meta.country_daily`, `placement_daily`, `device_daily` | Independently requested compatible breakdown rows. Never add these tables to base totals. Unsupported breakdowns are recorded without establishing zero results. |
| `meta.instagram_observations` | Native metric definitions/period/timeframe/type, availability, scalar/aggregate breakdown/native values, publication/permalink, observation timestamp, exact requested dates, version and explicit evidence kind/scope. |
| `meta.instagram_media` | Current post/carousel/Reel/Story metadata, IDs, publication dates/permalinks and observed version/time; carousel child metadata is retained. |
| `meta.coverage`, `checkpoints` | Per-account/grain/request-contract window attempts, mode, complete promotions, failures/unsupported windows and resumable async job IDs. |

Advertising historical collection starts at 1 January 2024, capped by configured bounds and each account's last completed local day. Actual API availability is unknown until diagnostics and bounded promotion succeed. Daily reach and frequency are deliberately not requested as additive evidence. CPA and ROAS are computed from aggregate compatible spend/count/value; null numerators/denominators stay unavailable. Native raw action evidence stays in the warehouse. Meta attribution is not verified first-time customers, incremental value or finance revenue; cross-platform credit is not deduplicated.

Instagram distinguishes `historical_daily`, exact `window_total`, `lifetime_total`, current `snapshot`, `audience_snapshot`, and unsupported/missing evidence. Native daily buckets use the reviewed endpoint timezone and returned exclusive `end_time`; verify that timezone against the actual response. Instagram since/until are Unix timestamps of the reviewed timezone's local date boundaries (including DST); collection never asserts a native bucket outside the requested window. The historical probe guard allows only the last 90 completed dates, a conservative request boundary rather than a promise that any metric has 90 days of history. Older observations remain available if already captured. Lifetime media totals and current followers do not reconstruct historical daily performance. Expired Stories are not recovered by changing requested dates.

Media rankings select **publication dates**, then use each metric/profile's latest observed lifetime totals. Account time series, exact report windows and snapshots are retrieved separately with their actual time semantics; reach, followers and audience distributions are not summed across days. Native Instagram insight scope remains `native_scope_unverified` for paid versus organic. No ad/media union, destination-to-product guess, organic-post sales attribution, messages or individual audience data is implemented.

## Concrete bounded plan and commands

The executable plan must name **one reviewed account** before writes. Replace the ID in `META_AD_ACCOUNT_ID` / `INSTAGRAM_ACCOUNT_ID`; do not use historic Google Ads customer IDs. Initial ads pilot: **2024-01-01 through 2024-01-07 inclusive**, one seven-day window, four independent dataset requests. First diagnose a single day. If 2024 history is rejected, record that boundary and inspect a more recent explicitly selected day; do not infer zero or blindly widen the import.

```sh
# Read-only identity diagnostic. Exactly one configured account is required.
npm run discover:meta -- --account "$META_AD_ACCOUNT_ID"
# Read-only one-day async Insights probes for base/country/placement/device.
npm run discover:meta -- --account "$META_AD_ACCOUNT_ID" --start 2024-01-01 --end 2024-01-01
# Concrete plan only; prints IDs/dates/metadata references, never secrets.
npm run backfill:meta -- --account "$META_AD_ACCOUNT_ID" --start 2024-01-01 --end 2024-01-07 --chunk-days 7 --max-windows 1
# Explicit bounded warehouse collection; repeat identically to resume.
npm run backfill:meta -- --account "$META_AD_ACCOUNT_ID" --start 2024-01-01 --end 2024-01-07 --chunk-days 7 --max-windows 1 --execute
# Same bounded window with intentional attribution re-fetch/replacement.
npm run backfill:meta -- --account "$META_AD_ACCOUNT_ID" --start 2024-01-01 --end 2024-01-07 --chunk-days 7 --max-windows 1 --refresh --execute
```

After the pilot succeeds, advance in explicit bounded batches. A 31-day January request with `--chunk-days 7 --max-windows 5` covers that month. Multi-year requests default to six windows and report `remaining_windows`; they never silently establish all-history coverage. Completed checkpoints are reused unless `--refresh`/scheduled. Pending async jobs resume; failed jobs can be reset to retry. Failed pages never promote data or mark complete coverage. Bounded retries, 30-second request timeouts, a shared 45-minute API deadline and per-account API/page budgets prevent indefinite runs. Stage tables expire after an hour and invocation-owned stages are cleaned. Atomic delete/insert promotion handles late revisions and repeat writes.

Instagram initial pilot: account/media current observations plus **2026-10-05** daily account evidence, if that is completed in the reviewed bucket timezone. Adjust this date at execution time.

```sh
npm run discover:instagram -- --account "$INSTAGRAM_ACCOUNT_ID"
npm run collect:instagram -- --account "$INSTAGRAM_ACCOUNT_ID" --start 2026-10-05 --end 2026-10-05
npm run collect:instagram -- --account "$INSTAGRAM_ACCOUNT_ID" --start 2026-10-05 --end 2026-10-05 --execute
```

Snapshot re-runs on the same account-local observation day replace that day's latest media/snapshot evidence; prior days stay retained. Native daily/exact-window observation replacement is limited to the selected requested window. This daily-snapshot contract does not preserve intraday Story time series. Do not activate more frequent Story collection until actual account availability demonstrates a need and the desired intraday retention contract has been reviewed.

Proposed daily UTC schedules: ads **07:10**, Instagram **07:40**. Change these per service to follow the last completed day of the configured accounts. Ads default to a **35-day rolling attribution refresh**, configurable per account up to 90 days; choose an overlap at least as long as the applicable attribution window plus expected revision lag. `historical_only`/`disabled` accounts are excluded from scheduled collection. Review and set only intended live accounts to `active` after diagnostics/pilot; historical evidence remains reportable regardless of scheduled status.

```sh
# Plan configured active accounts without collection.
node meta/cli.js meta_ads --scheduled --max-windows 100
node meta/cli.js instagram --scheduled
# Exact existing governed scheduler entrypoints; these collect when invoked.
npm run collect:freshness -- meta_ads
npm run collect:freshness -- instagram
# Read-only run ownership/lease recovery and health checks.
npm run collect:freshness -- meta_ads --recovery-check
npm run collect:freshness -- instagram --recovery-check
npm run audit:freshness
```

The runtime records actual scheduled versus manual promotions in native coverage, and Oracle's freshness audit exposes source timestamps, failures and observed scheduled execution. Configuration alone is not verified execution. Ads and Instagram share a six-hour warehouse lease; normal runs release only their owned lease. After a crash, inspect running ledger/lock and pending reports rather than forcibly clearing ownership while another run may still be active.

## Oracle paths and verification

`get_meta_performance` supports account/campaign/ad-set/ad/creative/current destination/month and independent country/placement/device breakdowns. Money and attribution contracts remain separate. `get_instagram_performance` supports native account/media metrics, media-type filtering and publication-date rankings. Shared deterministic routes cover the example questions, compatible follow-ups, exact comparisons, charts and XLSX exports. Exports use existing durable identity-owned storage/downloads, retain definitions and limitations, and recover exact saved bytes without a provider re-query. Rankings/exports are bounded at 100 provider rows and explicitly disclose the bound; charts show up to ten ranked items. Current creative URLs are retained as native evidence; no unvalidated URL/product joins are made.

The common business presentation leads with the answer/table and important attribution/coverage limits, with technical details under **Show details**. Unsupported/new subject requests cannot fall back to a retained unrelated report. Durable job recovery restores its validated analytical context; export manifests are readable independently of analytical session state.

```sh
node --test test/meta-instagram.test.js test/meta-instagram-http.test.js test/oracle-analysis-context.test.js test/oracle-analysis-route-dispatcher.test.js test/oracle-tool-schemas.test.js test/collector-runner.test.js test/freshness.test.js
node diagnostics/oracle-tool-schema-validation.js
# Repo fixtures must be independent of inherited live inventory selectors.
env -u SHOPIFY_INVENTORY_LOCATION_ID -u SHOPIFY_LOCATION_ID node --test
git diff --check
```

New tests exercise production-shaped pagination/async/rate-limit/token failures, partial promotion and resume, revisions, duplicate rows, multiple currencies/timezones, non-additive metrics, separate breakdowns, media/metric incompatibility, expired history, snapshot metadata, lock overlap, and the real dependency factory/direct dispatcher/interactive HTTP/durable worker/restart/export paths. They do not contact live Meta/Instagram/BigQuery or mutate production data. The opt-in live repository checks remain unrun until their access/deployment prerequisites are met.

Public source review: [Meta's current IGUser SDK contract](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/iguser.py), [IGMedia SDK contract](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/igmedia.py), [native Insights metric/period enums](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/instagraminsightsresult.py), and [Meta's Instagram API collection](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api). Meta's direct developer documentation returned unavailable/429 during this task; actual app/version grants and supported metrics still require account-specific discovery.

### Results from this task

- Full repository run: **949 passed, 3 opt-in checks skipped, 0 failed**, 952 tests, completed in 98.2 seconds. Inherited inventory selectors were removed for fixture isolation; no inventory collection occurred.
- Final focused run, including the added fail-closed source-health regression: **72 passed, 0 failed/skipped/cancelled**, completed in 1.7 seconds.
- Oracle tool validator: **45 strict schemas across 60 registered tools** validated. `node --check` passed for the server and changed entrypoints; staged `git diff --check` passed.
- No live Meta/Instagram/BigQuery import, production activation, merge or deployment was executed. Live syntax/IAM, token grants, account metadata, metric/media availability and historical API boundaries still need the bounded pilot above.
