# Visitor-country conversion: shared scope and read-only Shopify capability

## Change and preserved base

Fresh country-conversion questions had no independent population model. Retained
device context could also select the correct metric family while erasing the
requested visitor geography and comparison. `population_scope` now records the
geographic role, selected country and comparison groups independently of metrics,
period comparisons and dimensions. UK means visitor/session country. Global
includes UK and every other available visitor country, including unresolved
geographies in the unrestricted native total. Rest of world excludes UK.
Worldwide replaces the local filter; a later comparison can reuse the country
anchor. Device breakdown switches clear incompatible population filters.
Unsupported country pairs, platform mixtures, additional filters and geographic
roles are explicit limitations; they cannot silently become a country-only or
device report. Supported country/global comparisons share the same mechanism.

The unfinished work was preserved in a named Git stash and a tracked patch plus
untracked-file archive under `/tmp/oracle-population-preserved`. The publication
branch starts at `6eaf453a1e10ce018b6d811377f576035ad1a22c`, latest fetched main
containing merged [PR #327](https://github.com/lmnopstudios-dot/tgf-bigquery-sync/pull/327).
The basket SQL fix is inherited, not recreated: `oracle/basket-provider.js` has
no diff against that base. The persistent acceptance matrix preserves #327's SQL
boundary suite alongside both country suites.

## Native reader and evidence contract

`oracle/shopify-country-conversion.js` is registered through
`createOracleProviderDependencies` and the shared baseline/analysis dispatchers.
It uses the existing `SHOPIFY_SHOP`, `SHOPIFY_CLIENT_ID` and
`SHOPIFY_CLIENT_SECRET` with the existing Shopify admin client, API 2026-07.
Authentication does not request or change scopes. Metadata must supply shop
identity, authoritative IANA timezone and the installed `read_reports` grant.

The reader runs `FROM sessions` with an explicit human-session predicate. It
retrieves `sessions` and `sessions_that_completed_checkout` together by calendar
day. The local report additionally filters and groups by `session_country_code`.
The global report has no visitor-country restriction, top-N selection, device or
referrer filter. Rest-of-world counts are global minus the compatible local
counts for the same day; the remainder must itself be arithmetically possible.
Worldwide-only requests query global alone and do not depend on local coverage.

The documented source contract is
[Shopify's sessions schema](https://shopify.dev/docs/api/shopifyql/2026-07/schemas/sessions_and_behavior/sessions).
[GraphQL ShopifyQL access](https://shopify.dev/docs/apps/build/shopifyql/graphql-admin-api)
requires `read_reports`, Level 2 protected-customer-data access and API 2025-10 or
later. A documented field is a candidate capability, not proof of this shop's
access or historical rows. Only successful native responses establish a supported
reporting window. Missing grants, parse errors, unavailable counts, invalid
metadata, truncation, timeouts and network failures retain an explicit limitation.
No device, shipping-order or GA4 numerator fallback exists in this reader.

Bounds per request: at most 366 requested days, two pages of 400 rows per native
report, five GraphQL calls, one authentication exchange, 12 seconds per operation
and a 60-second overall reader deadline. No automatic retries or unbounded
historical discovery. Input dates and country codes are validated before network
access. Provider bodies, tokens and unrestricted errors are not returned.

Requests are restricted to completed shop-local dates and the governed Shopify
launch from 20 November 2025. The source retains the submitted window and reports
any excluded prefix/current/future dates. Missing daily counts are unavailable,
not zero; only explicit numeric zero counts are zero. Missing dates split the
supported reporting partitions. A successful report response does not certify
upstream tracking completeness or expose a stored collection timestamp.

The documented session rollout of 21–23 September 2026 is treated conservatively:
those dates are excluded until this shop's rollout date is independently verified,
and adjacent dates remain separate measurement partitions. The existing device
provider's 1 September constant is unchanged. Reconcile that separate legacy
boundary before claiming equivalence with device evidence. Shopify describes the
rollout and a general session-history floor of 1 October 2022 in
[its analytics change documentation](https://help.shopify.com/en/manual/reports-and-analytics/discrepancies/analytics-updates).
Neither the vendor floor nor the launch boundary certifies this shop's coverage.

The saved evidence includes bounded native reports, exact SQL/pagination, metadata,
requested populations and coverage. Direct, interactive, durable and recovery
validation rebuilds derived populations from those reports, checks the saved plan,
and recomputes ratios and percentage-point differences. Numerator, denominator,
country role, day, source, timezone, platform and group mismatches fail closed.
Rendering repairs and polling do not repeat the reader. Each supported partition
has a compact table with sessions, native conversion numerator, two-decimal rates
and percentage-point difference. Actual returned-day cutoffs, partial scope,
unknown upstream completeness and overlapping/disjoint groups are visible.

There is no collector, schema setup, persisted source-data table, schedule or
backfill dependency. Normal Oracle job/result persistence remains unchanged.

## Historical alternatives and required future work

| Source | Possible compatible measure | History and permissions |
|---|---|---|
| ShopifyQL sessions | Completed-checkout sessions / sessions, both under visitor-country scope | This reader can verify a bounded source window from governed launch, conditional on this shop's actual report responses. Existing app credentials and `read_reports` are used; no grant changes. |
| GA4 Data API | `ecommercePurchases` / `sessions` by `date` and visitor country, after property compatibility checks | Repository Woo contract: 18 August 2022–19 November 2025. Country counts remain unverified/uncollected. Requires property read access and Data API access. This is purchase events per session, not Shopify converted sessions. |
| GA4 Shopify era | Same GA4 event-based measure, if actually observed | Tracking is absent/incomplete from 20 November 2025 through 6 September 2026 under `ga4/semantic.js`; from 7 September 2026 it is provisional. It cannot establish full-year 2026 conversion. |
| Existing GA4 raw event export, if present | Internally deduplicated eligible sessions and purchase-containing sessions assigned one visitor-country rule | Export existence and retained history are unverified. Current repository GA4 tables are Data API aggregates. Dataset reads and query-job permissions would be required; a new export cannot recreate earlier raw sessions. |

Official GA4 references:
[API schema](https://developers.google.com/analytics/devguides/reporting/data/v1/api-schema),
[compatibility checking](https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/checkCompatibility),
[API setup](https://developers.google.com/analytics/devguides/reporting/data/v1/quickstart),
[BigQuery export](https://support.google.com/analytics/answer/9358801?hl=en),
[aggregate-report retention](https://support.google.com/analytics/answer/7667196?hl=en).
A key-event rate alone does not expose a native converted-session numerator.
Do not recover a count from a rounded percentage or use purchasers as converted
sessions. Do not combine shipping-destination orders with visitor sessions.

Future persistence, if separately authorized, needs a dedicated country-grain
aggregate, coverage/reconciliation ledger, retention policy, atomic/idempotent
replacement and scoped destination write privileges. Historical loading and
scheduling are separate actions. None is implemented or activated by this change.

## Live checks versus offline tests

The bounded live capability attempt used this environment's configured production
credential bindings for 12–13 October 2026. The initial attempt failed during
authentication; repeating through Node's supported environment-proxy mode returned
`NETWORK_FAILED` at `authentication`, zero GraphQL calls and no evidence cutoff.
No shop metadata or country reports were retrieved. This does not establish that
credentials are invalid, `read_reports` is absent, the source API is incompatible,
or historical country coverage is missing. It leaves all of those unverified.
No permissions or networking configuration were changed.

Offline tests exercise the production dependency factory and actual SQL/credential
transport against mocked Shopify responses, plus direct HTTP, interactive,
durable persistence/polling, tampered recovery and desktop/mobile browser paths.
Fixture data does not certify source access or production coverage. Final gate
counts and the publication commit are reported in the PR and completion response.
Deployed Oracle/browser acceptance remains a separate verification.

## Exact bounded Render verification, without deployment

Run from the existing Render service repository root. Fetching Git objects and
extracting a temporary copy does not change the running checkout or deployment.
Use the commit SHA returned with the PR to pin the first line; the branch form
below resolves and prints the fetched revision before execution. It reuses the
existing installation's dependencies and configured runtime credentials.

```sh
git fetch --no-tags origin fix/oracle-visitor-country-conversion
country_revision="$(git rev-parse FETCH_HEAD)"
country_probe_root="$(mktemp -d /tmp/oracle-country.XXXXXX)"
git archive "$country_revision" | tar -x -C "$country_probe_root"
ln -s "$PWD/node_modules" "$country_probe_root/node_modules"
printf 'Country reader revision: %s\n' "$country_revision"
timeout 65s node "$country_probe_root/diagnostics/oracle-country-conversion.mjs" --start 2026-10-12 --end 2026-10-13
```

Only if the first probe succeeds, verify the bounded governed history separately:

```sh
timeout 65s node "$country_probe_root/diagnostics/oracle-country-conversion.mjs" --start 2025-11-20 --end 2026-10-15
```

Each invocation executes the production country dependency only. It never imports
`server.js`, writes warehouse data, calls a collector or changes app permissions.
Failure exits nonzero with a safe stage/code and unavailable cutoff. Success
reports native aggregate counts, supported partitions, actual first/latest
compatible dates, missing/excluded days and source-quality limitations. A successful
short interval does not establish the historical interval or deployed UI delivery.
Git source access and existing installed dependencies must already be available;
this procedure does not install packages or request new permissions.
