# Search Console production semantic layer

## Properties and scope

The `search_console` dataset retains two independent sources: the Domain property `sc-domain:thegreatfroglondon.com` (`domain`, hostname `thegreatfroglondon.com`) and historical URL-prefix property `https://www.thegreatfroglondon.com/` (`url_prefix`, hostname `www.thegreatfroglondon.com`). Domain properties and URL-prefix properties have different scopes. Their overlapping metrics **must never be summed**.

Known final-data evidence runs from 2025-05-06 through 2026-09-15. The www evidence covered all 498 dates observed; Domain evidence covered 230 dates, with a large unavailable period beginning 2025-12-12 and evidence resuming in September 2026. This is coverage evidence, not an exact migration/canonical/redirect date. Externally, historical ecommerce used WooCommerce and the www hostname, while current ecommerce uses Shopify and the apex hostname; Search Console does not assign particular evidence to either platform.

## Objects and semantics

Source tables are `daily` (property/date), `queries` (property/date/query), `pages` (property/date/original page URL), and `device_country` (property/date/device/country). All preserve property provenance and API dimension values. CTR is clicks divided by impressions; aggregate position is impression-weighted. Page identity lowercases the hostname, retains the path and original URL, and drops scheme/query/fragment without asserting redirect or canonical equivalence.

`canonical_daily` emits exactly one row per requested date. It selects available Domain evidence first, otherwise available www evidence, otherwise NULL metrics with `coverage_status=unavailable`. Reasons are `preferred_domain_property`, `fallback_www_property`, and `no_available_property_evidence`. Zero observed metrics remain different from unavailable evidence. `canonical_queries`, `canonical_pages`, and `canonical_device_country` views join their source table to that date's selection and therefore cannot mix properties.

Google can omit anonymized or low-volume queries. Missing query rows are omitted evidence—not zero searches—and dimensional totals need not reconcile to daily totals. `query_pages` is deferred because material months reached the bounded 50,000-row discovery cap. Brand/non-brand classification is deferred until an approved brand dictionary exists.

## Operation

The API is read-only and requests `dataState=final`. The command enforces a three-day final-data candidate lag but does not promise Google freshness. A scheduled job should refresh a bounded rolling seven-day window ending three days ago. It validates full access to both governed properties before writes, caps pagination, retries transient errors, uses invocation-owned expiring stage tables, and transactionally replaces each property/table/range. Empty successful results deliberately remove that property's old range; API failures do not. Canonical dates are rebuilt after source staging. Stages are isolated and removed in `finally`.

```sh
npm run sync:search-console -- --start 2026-09-08 --end 2026-09-14
npm run validate:search-console -- --start 2026-09-08 --end 2026-09-14
```

After that small range validates, backfill in bounded month-sized invocations (never automatically on deploy), for example:

```sh
npm run sync:search-console -- --start 2025-05-06 --end 2025-05-31
npm run sync:search-console -- --start 2025-06-01 --end 2025-06-30
# Continue non-overlapping calendar-month ranges through the latest final date.
npm run validate:search-console -- --start 2025-05-06 --end 2026-09-15
```
