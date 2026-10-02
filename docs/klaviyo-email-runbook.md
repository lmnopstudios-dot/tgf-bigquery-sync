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
* `KLAVIYO_ACCOUNT_CONFIG` — optional path override for the versioned account configuration; normally use the repository default. `KLAVIYO_DISCOVERY_MANIFEST` is legacy pilot-only input.
* Existing `GOOGLE_PROJECT_ID` and `GOOGLE_SERVICE_ACCOUNT_JSON` for collection only.

The client redacts authorization values and never emits response bodies on errors. Discovery output contains aggregate counts, stable IDs, names/integration provenance, and report row counts—not profiles or customer-level events.

## Legacy pilot discovery record (superseded)

The commands in this section describe the already-completed August pilot only. They must not be used as the ongoing approval mechanism; the versioned configuration below supersedes `/tmp` manifests.

### Pilot discovery gate

Run this exact first command in Render Shell (it is read-only and bounded to eight pages per listing, 1,000 items, 40 calls, three retries, and 15 seconds per call):

```sh
npm run discover:klaviyo 2>&1 | tee /tmp/klaviyo-discovery.log
```

Review metric IDs and integration provenance and confirm both campaign and flow probes for `Xp9amv`. The capture can contain npm output around the JSON, so prepare a clean manifest with the bounded parser (replace the reviewer and timestamp with the real review provenance):

```sh
npm run prepare:klaviyo-manifest -- --input=/tmp/klaviyo-discovery.log --output=/tmp/klaviyo-reviewed.json --metric-ids=Xp9amv --reviewer='REVIEWER_NAME' --reviewed-at='2026-09-30T00:00:00Z'
```

The helper records the reviewed account settings, validates the exact pilot window and both probes, and preserves the byte-for-byte discovery capture beside the manifest as `/tmp/klaviyo-reviewed.json.discovery.log` with its SHA-256 and review provenance. It refuses to overwrite either file. Store both durably. Do not manually discard the original evidence.

### Legacy August pilot collection

```sh
KLAVIYO_DISCOVERY_MANIFEST=/tmp/klaviyo-reviewed.json KLAVIYO_CONVERSION_METRIC_IDS=Xp9amv KLAVIYO_ACCOUNT_TIMEZONE=Europe/London KLAVIYO_ACCOUNT_CURRENCY=GBP npm run collect:klaviyo-pilot
npm run diagnose:klaviyo-production
```

Collection is hard-coded to the August 1–September 1 exclusive report timeframe. It stages then atomically `MERGE`s on report kind, entity/message ID, window, and conversion metric ID, so retries are idempotent. A partial endpoint failure promotes nothing. Evidence has seven-year partition retention. Broad historical backfill is intentionally not implemented; approve one only after acceptance.

## Dashboard acceptance

For each chosen conversion metric ID independently, export/view Klaviyo campaign and flow reports with **August 1–31 2026**, the recorded timezone/currency, identical attribution window/settings, and email channel. Reconcile recipients/delivered, unique clicks, opens, bounces, unsubscribes, spam complaints, conversions and conversion value. Document dashboard export time, settings, metric ID and discrepancies. Differences must be explained as report population, message/report-window semantics, late attribution, privacy/machine opens or dashboard freshness—not forced to equal Shopify finance totals. Confirm click rate is unique clicks ÷ delivered and revenue per delivered is conversion value ÷ delivered where both compatible inputs exist.

The production diagnostic uses `config/klaviyo-account.json` by default (or the same optional `KLAVIYO_ACCOUNT_CONFIG` override as refresh), calls the bounded window collector and Oracle service helpers, performs no writes, and reports errors rather than zeros. It does not require the legacy temporary discovery manifest. A local run without production credentials is **not** live verification.

## Oracle coverage

Oracle exposes bounded tools for period performance, click/purchase opportunity ranking, and Klaviyo-versus-Shopify email-referrer comparison. Results include volumes beside rates, stored coverage, metric/currency/timezone/revision/settings, and limitations. Shopify referrer traffic is side-by-side only; it cannot establish all email influence or campaign-level device/session joins. Tool results remain structured evidence if answer synthesis fails.

After deployment, run this exact command in the Render Shell before considering any collection or data repair:

```sh
npm run diagnose:klaviyo-production
```

The command is read-only. It prints a bounded physical inventory and the exact Oracle SQL and bindings, then compares API and stored identities/statistics and Oracle evidence counts. A missing or inconsistent selected pilot exits nonzero; do not rerun collection unless this physical evidence shows that persistence failed.

## Historical discovery, backfill, and coverage

The account usage start is unknown. Keep it distinct from both the earliest dated object returned by bounded listing pagination and the months successfully promoted into `window_coverage`. Discovery never writes and never turns an inaccessible month into zero. In Render Shell, choose a defensible lower bound rather than inventing an account start:

```sh
KLAVIYO_MAX_API_CALLS=80 KLAVIYO_MAX_ELAPSED_MS=1200000 npm run discover:klaviyo-history -- --from=2025-11 --through=2026-05 --max-months=7 --metric-ids=Xp9amv > /tmp/klaviyo-history-discovery.json
KLAVIYO_MAX_API_CALLS=80 KLAVIYO_MAX_ELAPSED_MS=1200000 npm run discover:klaviyo-history -- --from=2025-11 --through=2026-05 --max-months=7 --metric-ids=Xp9amv --evidence=/tmp/klaviyo-history-discovery.json 2>&1 | tee /tmp/klaviyo-history-resume.log
```

The first command creates the original evidence capture; do not rerun it or redirect another command to that path. The second consumes that capture and writes a separate log. `--evidence` carries forward successful and successful-zero tasks, retries only failed or unattempted tasks in plan order, and then progresses; a failed metadata refresh is recorded separately and cannot erase earlier task evidence. Subsequent resumes must extract the JSON result from the latest resume log to a new, uniquely named evidence file rather than overwriting either capture, and pass that new file to `--evidence`.

The reporting endpoints in the pinned API revision are XS tier (steady 15 requests/minute). Historical discovery and backfill therefore serialize API attempts at least four seconds apart. A 429 honors both delta-seconds and HTTP-date `Retry-After` values without shortening the server delay. Retries still consume the API-call cap, and a delay that would exceed `KLAVIYO_MAX_ELAPSED_MS` (or collection `--max-duration-ms`) fails explicitly instead of sleeping beyond the bound.

The output lists the full metric catalogue with integration provenance, but probes only the explicit `--metric-ids` selection (default `Xp9amv`). Potential WooCommerce purchase metrics are shown as review-only candidates and are not probed automatically. It distinguishes successful probes, successful zero-row responses, request failures, tasks not attempted because of the call limit, earliest accessible dated metadata, and unknown account start. Review and commit any historical WooCommerce metric and evidenced applicability period in `metric_definitions` before selecting it. `Xp9amv` is approved for collection from November 2025. The reviewed production discovery capture for November 2025–July 2026 is stored at `evidence/klaviyo/xp9amv-history-discovery-2025-11-through-2026-07.json`; its sibling `.sha256` file verifies the durable capture. This is a transcription of reviewer-supplied production results, not a claim that this checkout read a remote Render `/tmp` file.

Stuart Hughes reviewed the captured Shopify provenance and demonstrated applicability for November 2025–July 2026. The reviewed configuration sets `metric_definitions[metric_id="Xp9amv"].collection_not_before` to `2025-11-01`; it does not change `approved_metric_ids`, infer October availability, or add a WooCommerce metric. After deployment of the reviewed commit, run the first bounded batch below. Each successful invocation prints an exact `resume_command`; compare it with the next command shown here before continuing. Stop on any failure or unfinished month:

```sh
KLAVIYO_MAX_API_CALLS=80 npm run backfill:klaviyo -- --from=2025-11 --through=2026-07 --max-months=3 --max-duration-ms=1200000
KLAVIYO_MAX_API_CALLS=80 npm run backfill:klaviyo -- --from=2026-02 --through=2026-07 --max-months=3 --max-duration-ms=1200000
KLAVIYO_MAX_API_CALLS=80 npm run backfill:klaviyo -- --from=2026-05 --through=2026-07 --max-months=3 --max-duration-ms=1200000
```

These batches cover November–January, February–April, and May–July respectively. They are manual commands only; this review does not run collection or activate scheduling. August and September have persisted reports but their missing coverage records must be handled by the bounded repair below; report rows alone are not collection-completeness evidence.

### Bounded August–September coverage repair

After deploying this commit, run the read-only audit in Render Shell:

```sh
npm run repair:klaviyo-coverage
```

The audit is fixed to August and September 2026. For each exact Europe/London month it requires a completed `succeeded` run, a matching run ID/retrieval timestamp and row count, unique stable report identities, both campaign and flow report kinds, and the reviewed metric ID, GBP currency, timezone, and serialized attribution settings. Existing report rows without all that evidence are explicitly insufficient. It also inventories November 2025–September 2026 coverage and does not write.

If both months say `eligible_for_coverage_repair` (or one is already collected), run the guarded transaction and then repeat the audit:

```sh
npm run repair:klaviyo-coverage -- --apply
npm run repair:klaviyo-coverage
```

The transaction repeats every assertion before its idempotent coverage `MERGE`; it does not update report rows or identities. If either month reports `refresh_required_*`, do not use `--apply`. Run only the exact refresh command(s) emitted by the audit, one at a time, followed by the audit. The supported fallback commands are:

```sh
npm run refresh:klaviyo -- --start=2026-08-01 --end=2026-08-31
npm run refresh:klaviyo -- --start=2026-09-01 --end=2026-09-30
npm run repair:klaviyo-coverage
```

Each refresh uses the normal atomic, stable-key upsert, so it preserves report identity and cannot create a second row at the report grain. Accept collection completeness only when the final audit reports all 11 expected months, November 2025 through September 2026, in `collected_months`, with `missing_months: []` and `complete: true`. September's `attribution_provisional` flag is reported independently and does not change collection completeness. Stored current attribution settings remain retrieval-time settings and do not establish what settings applied historically.

These are manual Render Shell commands. This repository change neither executes them, demonstrates production acceptance, nor activates the schedule.

Verify every exact Europe/London month after its batch (all commands are read-only):

```sh
npm run verify:klaviyo-refresh -- --start=2025-11-01 --end=2025-11-30
npm run verify:klaviyo-refresh -- --start=2025-12-01 --end=2025-12-31
npm run verify:klaviyo-refresh -- --start=2026-01-01 --end=2026-01-31
npm run verify:klaviyo-refresh -- --start=2026-02-01 --end=2026-02-28
npm run verify:klaviyo-refresh -- --start=2026-03-01 --end=2026-03-31
npm run verify:klaviyo-refresh -- --start=2026-04-01 --end=2026-04-30
npm run verify:klaviyo-refresh -- --start=2026-05-01 --end=2026-05-31
npm run verify:klaviyo-refresh -- --start=2026-06-01 --end=2026-06-30
npm run verify:klaviyo-refresh -- --start=2026-07-01 --end=2026-07-31
npm run diagnose:klaviyo-production
```

Each successful month uses the existing run lock and one atomic transaction for reports, dated metadata, success status, and coverage. The output's exact `resume_command` starts after the last committed month. Stable keys make retries idempotent. A successful empty report is `collected` with `row_count=0`; missing, unsupported, and failed periods are not manufactured. Calls, listing/report pages, duration, and months are bounded.

History may be limited by endpoint retention, scopes, revision, pagination/call bounds, deleted objects, and metric/integration lifetime. Never promise “all data.” Stored current attribution settings describe report retrieval; they do not prove those settings applied historically.

## Incremental refresh contract and Render schedule (not yet activated)

The durable reviewed account configuration is `config/klaviyo-account.json`; changing a metric ID or attribution setting requires normal code review and a versioned commit. `/tmp` is no longer an approval source. Secrets remain environment variables. Production evidence supplied for August 2026 is evidence, not a fixture: two campaign and two flow message rows were persisted and reconciled through parameterized, literal, and Oracle reads. Live drift is a separate observation. The repository's tests are mocked and do not repeat that production verification.

`message_performance` has one authoritative row per report kind, entity ID, message ID, exact half-open report window, and conversion metric. Re-collecting that grain updates its statistics and `retrieved_at`; it does not append a countable snapshot. Oracle accepts only an exact requested window and therefore never sums overlapping windows. Message-level unique clicks/opens may be summed for a message table, but are **not globally unique people**.

The scheduled command is designed for the existing external authenticated Render scheduling infrastructure, but this change does not activate or verify a schedule:

```sh
npm run schedule:klaviyo
```

It refreshes the previous and current exact calendar months every day, capturing late attribution and month-boundary corrections. In October this recollects September after the five-day attribution period. The current month is partial and a recent window is provisional. The API client has bounded retries, all pages are required, and a BigQuery `running` record prevents concurrent runs. Success is recorded only after campaign, flow, metadata, status, and coverage promote atomically. Failures and last success remain visible; a stale lock expires after 30 minutes but remains evidence.

In the existing authenticated Render scheduling service, create a **daily 06:15 UTC** cron job with command `npm run schedule:klaviyo`, the deployed branch/repository, and the same secret environment group. Set `KLAVIYO_MAX_API_CALLS=80`. Keep overlapping deploy/start triggers disabled. Run it manually once, inspect Render logs, and verify both monthly ledger/coverage records using the commands above. Only then describe automation as active; before that it is configured but unverified.

### Streaming-buffer incident and persistence guarantee

In the currently generated promotion script, BigQuery location **`[47:1]` is exactly** the `MERGE` into `klaviyo.entity_metadata` (line 43 begins the transaction, lines 44–46 merge reports, and line 47 begins the metadata merge). It is not the later metadata cleanup `DELETE`. A buffered-row error at `[47:1]` therefore establishes that metadata promotion was blocked; it does not establish whether an earlier historical implementation partially wrote reports or metadata.

The failed August attempt used this exact write order: create a report staging table; call `table.insert(rows)` (the streaming insert path) into that stage; `MERGE` the stage into `message_performance`; delete the stage; call `entity_metadata.insert(metadata)` (again the streaming insert path); then `DELETE` older metadata versions. The reported 400 names `entity_metadata`, so it was the final metadata `DELETE`, not collection or the report `MERGE`, that encountered rows just placed in that table's streaming buffer. Consequently, report promotion and the metadata streaming insert may already have completed even though `sync_status` was marked failed. That is the incident hypothesis; use the read-only verification below to establish the actual production rows rather than assuming either outcome.

The replacement sends bounded rows as typed JSON query parameters, materializes query-job temporary tables, and performs the report `MERGE`, metadata `MERGE`, superseded-metadata cleanup, and `sync_status` success transition in one BigQuery transaction. Immediately before that promotion query it reads both tables' metadata and exits with `waiting_for_streaming_buffers` plus the table-level buffer details if either buffer is non-null. This is a state gate, not a sleep, and it never truncates or deletes buffered data. There is no `table.insert` on either mutable path. Stable report IDs remain the `MERGE` key, the metadata `MERGE` changes only collected stable IDs, and cleanup retains the newest row for every metadata stable ID—including unrelated IDs. A promotion query error rolls back report changes, metadata changes, cleanup, and the success transition together; the catch path can only change a still-`running` ledger row to `failed`. This atomic guarantee applies to the replacement transaction, not to earlier attempts made by the old multi-step writer.

### Bounded August incident verification and recovery

After deploying the fix, first run the incident verifier. It is read-only, caps each query at 10 GB, lists at most 20 attempts and 1,000 exact-window rows, correlates persisted `retrieved_at` values with each failed attempt, and reports the BigQuery `streamingBuffer` metadata for both mutable tables:

```sh
npm run verify:klaviyo-refresh -- --start=2026-08-01 --end=2026-08-31
```

The verifier binds London window instants with the Google client `BigQueryTimestamp` contract and also runs an independent SQL `TIMESTAMP('…Z')` literal control. Interpret `failed_report_writes` and `failed_metadata_writes` only as bounded timestamp-correlation evidence. Historical attempts with null `started_at`, null failed `completed_at`, or no promotion `retrieved_at` are explicitly labelled `indeterminate`; a zero produced from incomplete timestamps cannot prove absence of partial writes and does not justify deleting anything. Save this JSON with the deployment record. Do **not** retry while either `message_performance_streaming_buffer` or `entity_metadata_streaming_buffer` is non-null. Keep scheduling disabled and re-run only the read-only verifier to observe state; this is a state check, not a fixed sleep. Do not truncate either table and do not manually delete metadata.

When both streaming-buffer fields are null, the retry is safe and idempotent:

```sh
npm run refresh:klaviyo -- --start=2026-08-01 --end=2026-08-31
```

Then verify both the attempt ledger/exact physical window and the independent API/stored/literal/Oracle reconciliation:

```sh
npm run verify:klaviyo-refresh -- --start=2026-08-01 --end=2026-08-31
npm run diagnose:klaviyo-production
```

Accept recovery only when the latest exact-window attempt is `succeeded`, neither table reports a streaming buffer, both the parameterized and literal exact-window controls contain the rows once at the stable grain, and `diagnose:klaviyo-production` passes its independent live API/stored/typed-literal/Oracle reconciliation. Until all checks pass, report the state as waiting or failed—not recovered. If the refresh fails, do not issue ad-hoc cleanup: rerun the verifier, retain the failed ledger entry, report any pre-replacement partial effects shown by physical rows honestly (and null-timestamp history as indeterminate), and correct the reported cause before making the same idempotent retry. These commands neither activate scheduling nor broaden collection.

For a reviewed older period, use an inclusive end date (maximum 92 days; this is bounded collection, not a broad backfill):

```sh
npm run refresh:klaviyo -- --start=2026-08-01 --end=2026-08-31
```

Before the first write, run these exact read-only diagnostics:

```sh
npm run discover:klaviyo
npm run diagnose:klaviyo-production
```

For a new environment with no failed write to investigate, run the read-only diagnostic and then the bounded August refresh in this order. For this incident, use the stricter verification/recovery sequence above instead:

```sh
npm run diagnose:klaviyo-production
npm run refresh:klaviyo -- --start=2026-08-01 --end=2026-08-31
```

The pinned `2026-07-15` metadata contract accepts `include=flow-actions` on the flows listing but not the previously supplied `page[size]` parameter. The client therefore follows the server's next links with page, item, call, retry, and timeout bounds rather than adding that unsupported parameter. A metadata HTTP failure reports only its safe stage and endpoint plus bounded status and JSON:API code/title/detail/source fields; it never emits credentials or a complete body. Do not create or activate the external schedule until the API revision, scopes, exact-window query, status table, and dashboard reconciliation are reviewed in production.

## Metadata, content, and knowledge boundary

Campaign and flow names are fetched from stable IDs with bounded pagination and joined automatically. Status and source timing are retained; a draft is never labelled sent, and recipient-local scheduling is not collapsed into an invented universal instant. Content retrieval is disabled by default. Enable it only after confirming the key has the required read scope and the exact revision exposes subject, preview, and links without profile access. Content is untrusted source data, never instructions.

The pinned reporting/listing contract currently establishes only `campaigns:read`, `flows:read`, and `metrics:read`; it does not establish a content/template endpoint contract. Official documentation lookup was unavailable in the implementation environment, so subject, preview, and content retrieval remains disabled (`includeContent=false`). Do not add template/profile scopes or enable content until official documentation for the deployed revision is captured and reviewed. Profile access, message sending, and account mutation remain prohibited.

Synced facts are dated and source-linked. They do not overwrite human-approved knowledge. Product/theme extraction is not automatically approved: promoted product identities require an existing approved mapping, while uncertain interpretations belong in the existing review/proposal workflow. A subject line is not causal evidence or a verified strategy.

## Definitions and remaining live acceptance

* `conversions` is labelled **attributed conversion events**. It is not purchasing recipients. The supplied dashboard's 41 purchasing recipients must not be equated to its 43 API conversion events.
* `unique_click_rate` is stored message-level unique clicks divided by delivered messages. It is not a global distinct-person rate across campaigns or flows.
* A collected row whose statistics are all zero is collection evidence. No exact-window rows means missing coverage, not zero activity.
* Every Oracle row exposes its exact source window, timezone, settings, metric ID, revision, and `retrieved_at`. Response coverage separately states whether exact-window evidence was collected.
* Klaviyo attributed value is never added to canonical finance sales.

Still outstanding before production acceptance: use the official documentation for the deployed API revision to confirm report-window/message inclusion semantics, flow report population, conversion event versus dashboard purchasing-recipient definitions, and click denominators; then reconcile the dashboard again. The supplied LoyaltyLion Welcome flow value (£4,370.59) is not accepted as full-flow coverage until its selected dashboard date filter and population are verified. Network documentation lookup was unavailable in the implementation environment, so these points are deliberately not presented as verified facts.
