# Oracle product-export category continuity

## Demonstrated cause

The repository path reproduces the supplied two-turn conversation. Before this
change, `resolveProductReportConfig` had no category field. The first request
became a current-online-published product report with a pending metric; “Units
sold.” filled the metric, but there was no pendant predicate to retain. The
catalogue GraphQL query returned publication, ID, title, URL and SEO description
only. Neither provider arguments nor `rankProductReport` applied a category.
The workbook wrote all ranked root products. This establishes a filter that was
never resolved/represented, rather than evidence of a resolved filter being
lost during clarification. The production incident's original persisted request,
job and 600-row workbook were not available in this workspace; its exact live
IDs and runtime revision still need a read-only incident check.

## Selection contract

`catalogue_filter` is independent of metric columns, dates, sorting, limits and
XLSX presentation. Metric-only clarification and additive/sort refinements keep
it. “Export rings by units sold this year” starts a new report. “Only ready-to-ship
products” intersects an existing category with an actual ready-to-ship structured
classification. It never means positive inventory or infers readiness from the
absence of a made-to-order tag. “Export all products instead” explicitly clears
category/readiness and keeps the metrics, dates and sort.

The export first reads every published root product page, inspecting native
product type, tags and collection membership. Collection membership also
paginates; the embedded connection starts at five memberships to keep the
100-product GraphQL page below excessive nested query cost. Normalization is
limited to case, spacing/hyphens and pendant/ring/earring singular/plural forms.
Product titles play no role. Multiple matching structured sources with different
ID populations require a short source clarification. Missing classification or
incomplete catalogue inspection produces a limitation, never a whole-catalogue
fallback. This path does not require classification sync or mutation.

Selection precedes source enrichment and ranking. Provider SQL is bounded by
selected root IDs or canonical product URLs. Ranking retains unmatched products
and writes unavailable cells as blanks. The source-native units binding remains
original Shopify line quantity, not returned/net units; existing payment and
cancellation eligibility semantics are unchanged. URL ambiguity is checked
against the full catalogue, including products outside the selected category.

Saved evidence includes the requested filter, native binding provenance and exact
selected product IDs. Preview, chart inputs and workbook share the same ranked
rows. Recovery checks the original stored request as well as the saved context (including
legacy contexts that already lost their category), full report configuration, selection contract, row IDs,
counts and native row classification, rejecting older filtered evidence without
this contract. Existing unfiltered downloads remain accessible.

## Verification

`test/oracle-product-category-export.test.js` exercises the exact incident through
both authenticated interactive and durable HTTP delivery, downloadable XLSX,
retry, refresh, rings, readiness intersection, landing-session sorting, added
organic clicks and explicit all-products expansion. Assertions inspect selected
IDs, provider arguments, chart population and actual workbook hyperlinks/cells,
including a blank units cell for a pendant without analytics. Additional cases
cover ambiguity/source clarification, unknown filters, misleading titles, product
and collection membership pagination, empty ID intersections, incomplete
classification and stale evidence. Production source-loader SQL parameters are
also inspected. Existing report, priority, continuity, chart and download tests
are retained.

## Remaining live checks

After normal release approval outside this task, inspect the incident's original
request/job/context/export, confirm the actual Shopify classifications and
permissions to read product collections, and compare selected IDs and downloaded
rows with those native classifications. Validate scoped BigQuery statements
against the existing datasets. No live collection/backfill, inventory read,
source/knowledge write, schedule change, deployment or merge was performed here.
