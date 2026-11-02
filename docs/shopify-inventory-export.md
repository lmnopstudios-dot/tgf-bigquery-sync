# Shopify inventory export

Oracle routes catalogue-wide stock requests such as “stock for everything except
made-to-order” through a live, read-only Shopify report. The catalogue is scanned
first to record actual tags. Eligibility uses the trimmed, case-insensitive exact
product tag `made-to-order`; product titles never determine eligibility. Similar
but different tags are reported, not silently treated as equivalent. ACTIVE and
DRAFT products are included with their status; ARCHIVED products are excluded.

The Inventory sheet has one row per variant, stable product/variant IDs, SKU,
selected options and tags, separate Available columns for each active location
(name and ID), a complete Available total, and an observed subtotal. Unknown
locations leave the complete total blank. Location quantities is the second
sheet, with Available, On hand and Committed kept separate, actual batch read
timestamps, evidence states and coverage failures. A null inventory level is
`unstocked`; false tracking is `untracked`; omitted nodes/read errors are `failed`.
Explicit numeric zero and negative quantities remain numeric. Quantities are
observations over the reported retrieval interval, not an atomic Shopify snapshot.

Products, variants and locations paginate until exhaustion or a disclosed
failure/limit. Limits are 20,000 GraphQL attempts, 100,000 retained variants,
1,000,000 location rows, ten minutes maximum (the caller may impose a shorter
request deadline), 8 MB serialized durable artifact storage, 16,384 columns and 32,767 characters per Excel cell. There are no
legacy 25-product, 500-variant, five-variant-page or ten-location cutoffs. Coverage
failures and limits are recorded in the workbook. Row/storage overflow rejects
the export explicitly rather than silently truncating a successful workbook.
Normal downloads use the existing authenticated durable export store; saved
workbook bytes are verified on download and recovery without Shopify replay.

## Read-only Render validation

Run once from the deployed application directory, using its existing Shopify
credential environment. Do not echo environment variables or add credentials to
the command:

```sh
node diagnostics/shopify-inventory-export.js --output=/tmp/oracle-inventory.xlsx
```

The command executes the shared report service and governed request entrypoint,
using an in-memory export store and a local XLSX file so it performs no remote
writes. It prints observed related tags and counts, the predicate, statuses,
location coverage, quantity states, timestamps, failures, limits and workbook
checksum. It checks every workbook cell against the retrieved evidence. It exits
nonzero on incomplete coverage, an unobserved canonical exclusion tag, a storage
limit or validation failure. An incomplete workbook, if created, remains labelled
as incomplete; it is not evidence of full inventory coverage. Credentials and
upstream exception bodies are never printed.

Live Shopify tag inspection and export validation are **pending** until this
command succeeds. Offline fixtures verify routing, pagination, numeric semantics,
XLSX contents, direct/interactive/durable delivery, authenticated downloads and
browser recovery; they do not verify the deployed store or deployed revision.
