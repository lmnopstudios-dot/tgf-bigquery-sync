# Inventory incident 5a29d1f7-b66d-4742-9006-649bf270e82e

## Confirmed live catalogue rejection

The user supplied a read-only Render probe on 2026-11-02 showing:

- Product: `gid://shopify/Product/10434334097735`
- Catalogue page 1, zero-based node index 38
- Rejected field: `status`; observed type `string`; value `UNLISTED`

The original three-status validator rejected this valid response and stopped the
catalogue scan. Earlier products could still receive inventory reads and appear
in a valid but partial workbook. Inventory/workbook success therefore did not
establish a complete catalogue. The exact safe probe output is retained in
`test/fixtures/inventory-5a29d1f7/catalogue-validation.json`.

Shopify added UNLISTED in Admin API 2025-10. It is a distinct active product status
and must be preserved in the native status column:
https://shopify.dev/changelog/posts/new-unlisted-product-status
https://shopify.dev/docs/api/admin-graphql/2026-01/enums/ProductStatus

The fixed validator recognises all four current statuses. Population eligibility
is separate: broad non-archived exports include UNLISTED; explicit active/draft
exports audit its exclusion. Unknown statuses or malformed fields still stop the
scan with safe field/type/value/page/index diagnostics and incomplete coverage.
A full product-eligibility audit prevents silent disappearance of valid products.

## Separate interactive rejection — integrity stage confirmed

The user supplied correlated logs from deployed revision
`2afbd0b9b1caae9a226cfecf5e214a520ff78f97`. The canonical request selected
`current_stock` / `get_shopify_inventory_by_location`, then the interactive
`agent_request` failed after 18,082 ms with `EXPORT_INTEGRITY_FAILED`.
There was no durable job and no general-agent fallback for this correlation.
The sanitized log facts are retained in `interactive-log.json` beside the
catalogue probe fixture. The earlier `bbd9c579` request took the general-agent
route with zero tool calls; it is a separate intent-recognition failure.

A production-store-shaped regression reproduces `EXPORT_INTEGRITY_FAILED` by
reordering only the saved artifact's JSON object members. The workbook bytes,
checksum, inventory quantities and scope remain unchanged. BigQuery native JSON
may reorder object members, but the original verifier rebuilt metadata JSON
strings and compared their spelling. Location failures, limits and observed-tag
metadata could therefore fail after persistence. This is a confirmed local
mechanism consistent with the deployed code; the owner-scoped retained-artifact
probe reports whether the original saved workbook has those exact differences.
It performs a bounded SELECT independently of missing job evidence, never DDL
or report replay. The retained artifact itself has not been fetched from this
network-restricted workspace.

The fix canonicalises new JSON metadata and compares only the explicitly JSON
metadata cells using parsed JSON semantics, so legacy saved bytes remain valid.
All workbook byte checksums, non-JSON cells, numeric quantities, identities,
statuses, sheet/header layout, JSON primitive types and array order remain strict.
Actual changes still fail with safe sheet/row/column integrity diagnostics.
No corrupted workbook is accepted merely because the hash matches.

The production route is `/api/oracle/chat` → shared context/decision → baseline
dispatcher → current stock service → inventory report service. This governed path
executes locally rather than using the model's internal `/agent` fallback. The
interactive caller supplies a 60-second deadline; durable governed jobs supply
their own runtime deadline. Inventory reads clip that to ten minutes and bound
individual HTTP operations to 30 seconds. Inventory failures preserve partial
coverage. Workbook generation, storage lookup, artifact size, persistence,
verification and evidence delivery can each reject separately. The report now
labels those stages, durations and safe error codes in the existing correlated
provider-stage logs. No timeout extension or speculative storage fix is included.

Normal persistence uses the production BigQuery export-store adapter and its
8 MB serialized JSON bound, then verifies the persisted workbook. Downloads
revalidate saved bytes. The standalone diagnostic bypasses that store to recover
the requested workbook without waiting for a conversational repair. It retains
all locations and incomplete flags and does not establish chat-delivery success.

## Validation boundaries

The production-chat regressions run the real authenticated chat router, baseline
dispatcher, stock service, BigQuery export-store adapter and XLSX code with mocked
Shopify and warehouse responses. They include the exact retained field/value and
position, subsequent-page products, all six locations, intentional status/tag
exclusions, stage-specific storage/workbook failures and partial local recovery.
Browser regressions exercise visible download and refresh on desktop/mobile.
These are mocked remote reads, not a complete live catalogue export.

A complete fixed live export remains pending until the Render diagnostic succeeds
with `catalogue_complete=true`, the full status/product counts, all six active
locations and `complete=true`. The original interactive rejection is confirmed at integrity verification;
matching its specific saved artifact to the JSON-order false positive remains
pending the owner-scoped read. Neither claim establishes a complete live export.
