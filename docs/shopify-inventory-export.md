# Shopify inventory export

Oracle routes catalogue-wide stock requests such as “stock for everything except
made-to-order” through a live, read-only Shopify report. It scans actual tags
first. Eligibility uses the trimmed, case-insensitive exact product tag
`made-to-order`; product titles never determine eligibility. Similar but different
tags are reported, not silently treated as equivalent.

Schema validation accepts Shopify's ACTIVE, DRAFT, ARCHIVED and UNLISTED statuses.
Broad “all products” requests include ACTIVE, DRAFT and UNLISTED, excluding
ARCHIVED. Explicit “all active and draft products” requests include exactly ACTIVE
and DRAFT. The original native status is always retained. The Product eligibility
sheet audits every validated catalogue product, including deliberate exclusions;
status counts and catalogue completeness are also available in diagnostic output.
This separates schema validity from population eligibility. A malformed product
still stops the catalogue scan with a field-level error and incomplete coverage;
it is never silently skipped.

The Inventory sheet has one row per variant, stable product/variant IDs, SKU,
selected options and tags, separate Available columns for every active location
(name and ID), a complete Available total, and an observed subtotal. Unknown
locations leave the complete total blank. Location quantities remains the second
sheet, with Available, On hand and Committed kept separate, actual batch read
timestamps, evidence states and coverage failures. A null inventory level is
`unstocked`; false tracking is `untracked`; omitted nodes/read errors are `failed`.
Explicit numeric zero and negative quantities remain numeric. Quantities are
observations over the reported retrieval interval, not an atomic Shopify snapshot.
There is no configured-location restriction or six-location truncation.

Products, variants and locations paginate until exhaustion or a disclosed
failure/limit. Limits are 20,000 GraphQL attempts, 100,000 retained variants,
1,000,000 location rows, ten minutes maximum (the caller may impose a shorter
request deadline), 8 MB serialized durable artifact storage, 16,384 columns and
32,767 characters per Excel cell. Row/storage overflow rejects the export rather
than silently truncating it. Normal downloads use authenticated durable export
storage; saved bytes are verified on download and recovery without Shopify replay.
JSON metadata compares parsed semantics because native JSON storage can reorder
object members. Checksums, quantities, identities, statuses and array order remain
strict, including for legacy workbooks.

## Read-only Render recovery and validation

Run from the deployed application directory with the fixed revision and its
existing Shopify credentials. Do not echo environment variables or add credentials:

```sh
node diagnostics/shopify-inventory-export.js --request-id=5a29d1f7-b66d-4742-9006-649bf270e82e --expected-locations=6 --output=/tmp/oracle-inventory-5a29d1f7.xlsx
```

The diagnostic prioritises a local workbook using the Shopify reader directly.
It bypasses conversational routing and durable JSON artifact storage, including
the 8 MB durable-artifact limit; Excel/read bounds remain enforced. It does not
modify Shopify or write warehouse data. An expected-location count mismatch marks coverage incomplete without dropping locations.
An optional retained-job lookup runs
independently, so missing job evidence cannot prevent the workbook. An owner-scoped retained-export SELECT also checks the saved workbook and
reports legacy JSON member-order false positives. Interactive failures without
a durable job still require correlated deployed logs to establish the route and
terminal error.

Output includes per-operation safe errors and progress, field-level catalogue
validation failures, status counts, eligible statuses, scanned/eligible product
counts, every active location, inventory states, coverage, timestamps and a
workbook checksum. Every workbook cell is checked against the evidence. Credentials,
raw provider bodies, titles and tag contents are not included in errors; only
bounded enum-like status values and non-string scalar invalid values are exposed.
The explicit related-tag audit still reports actual relevant product tags.

Exit 0 means complete reads, observed canonical tag convention and workbook
integrity checks. Exit 2 preserves a partial workbook and coverage flags; exit 1
means execution/validation failed. A file alone never proves catalogue completeness.
Local diagnostic success does not establish conversational storage or delivery.
