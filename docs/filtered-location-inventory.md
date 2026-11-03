# Filtered location inventory exports

Oracle supports variant inventory exports whose Available predicates compare a
sum of explicitly named POS locations and a separate single online location.
The canonical acceptance request is retained verbatim in
`test/helpers/filtered-inventory.js`:

> Active variants where Kings Cross + Shoreditch + Soho available stock > 7,
> and Online Ready to Ship available stock < 3. Include made-to-order products.
> Exclude exact `enquire` tags case-insensitively, and exclude draft, unlisted
> and archived products. Exclude workshops. Generate a downloadable Excel file
> with one row per variant and sort total POS descending.

“Active variants” means variants of products whose native ProductStatus is
ACTIVE; Shopify variants have no separate active/draft/unlisted status. This
request does not restrict purchasability, inventory policy or product titles.
Made-to-order tags do not exclude a product. Only an exact case-insensitive
`enquire` tag excludes it; `pre-enquire`, `enquire later` and an Enquire product
title remain eligible unless another requested predicate excludes them.

The shared context validates and persists an `inventory_report` configuration:
product statuses, excluded tags, two named location groups, comparison operators
and thresholds, workshop exclusion, required-known Available quantities and sort.
The analytical plan records the same configuration, variant grain and native
Available measure. The job route is selected from that resolved context, before
reads. Filtered export requests never invoke the capped title/product stock reader.
Invalid expressions fail explicitly rather than becoming an unfiltered export.

Every product, variant and location connection uses the existing paginated
inventory report reader. Active location names bind using case-insensitive exact
name equality to the IDs returned by live Shopify. The existing six-location
metadata would bind Kings Cross to Location/104532967751, Shoreditch to
Location/104532836679, Soho to Location/104514388295 and Online Ready to Ship to
Location/105063874887. These IDs are reference evidence in the regression, not
hardcoded account bindings. The runtime resolves current IDs on every fresh read.
A missing or ambiguous name is a coverage failure. Workshops cannot substitute
for a store and are not included in level reads or the POS sum.

Qualification requires tracked inventory with finite numeric Available at every
required location. Missing/failed reads, null levels (unstocked), untracked items
and unavailable Available values remain unknown and cannot qualify. Explicit
zero and negative numbers remain numeric. On hand and Committed are never added
to Available. Strict `>` and `<` boundaries are preserved: POS exactly 7 and
online exactly 3 do not qualify. Nearby thresholds, negative thresholds and
`>=`/`<=` use the same typed predicate machinery.

The first XLSX sheet contains qualifying variants only, with product, native
status, IDs, SKU, size/options, tags, each POS store's Available, total POS and
online RTS Available. It sorts by total POS descending, then stable variant ID
for ties. The second sheet retains native location quantities. Coverage records
the requested filters, resolved location IDs, qualifying/unknown counts, read
timestamps, failures and limits. Coverage retains aggregate variant selection counts and inventory states; the
product eligibility sheet audits catalogue exclusions. Full per-variant
quantities are retained for qualifying rows only (see Storage projection below). An empty result retains the
requested headers and an artifact row count of zero.

The existing authenticated export store, size limits, download checksum/cell
verification and durable polling/recovery apply. Inventory filter agreement is
checked against the context, original request and stored artifact; changing or
omitting filters cannot silently broaden a saved download. JSON object member
reordering is harmless, but actual filter/value changes are rejected. Manifest
and browser export recovery retain the typed inventory configuration. Switching
subjects clears it. Recovery and presentation do not replay Shopify reads.

## Validation boundaries

The exact request is tested through the production chat router, route preflight,
baseline dispatcher, paginated reader, background worker, SQL export-store
adapter, authenticated polling, actual XLSX bytes and saved-artifact recovery.
Shopify/warehouse responses are mocked, including native JSON member reordering.
Desktop/mobile composer checks assert submission to `/jobs`, sorted workbook
contents and refresh without provider replay. Tests cover tag/status eligibility,
strict boundaries, negative/zero quantities, missing/duplicate locations, failed
reads, unknown values, modified persisted filters and an empty qualifying set.

These regressions do not establish a current live qualifying population. The
Nov 2 live validation belongs to the previous broad catalogue report, not this
new filter. No live Shopify products, tags or stock are modified by this change.
All existing pagination, deadline, Excel and durable-storage bounds remain in
force; any incomplete read is still disclosed rather than treated as zero.

## Multiline request routing (#405 follow-up)

The unchanged failed submission is retained in
`test/fixtures/inventory-multiline/failed-submission.txt`. At #405's exact source
commit, it returned no inventory scope: comparisons before “available units” and
comma/and-separated store names missed the narrower grammar. The real UI router
classified it as `policy_definition`. A generic job heuristic still chose `job`,
but the worker reached the general agent without inventory configuration. The
retained reproduction trace uses mocked providers; it does not establish the
running Render revision or replace correlated production logs.

The parser now accepts word/symbol comparisons, bullets and line breaks, and
“Exclude products tagged enquire”. The same typed filters travel through
preflight, context, plan, worker and artifact download. Catalogue export intent
is recognised separately from supported predicate grammar: an unresolved export
returns a typed scope error, and the legacy model tool rejects such requests
before Shopify authentication. Numeric comparison lines are not quoted documents.

### Separate deployed checks

After deploying this revision, run in the Render application directory:

```bash
node diagnostics/oracle-inventory-chat-delivery.js
```

This reads the running HTTP revision, verifies ancestry of #405 when Git history
is present, authenticates with the configured UI password, and sends the retained
submission through the actual HTTP route preflight. It does not request Shopify
reads. A selected `job` alone is insufficient: typed scope must match too.

To submit one live read-only inventory job, poll it and validate the authenticated
normal download, run:

```bash
node diagnostics/oracle-inventory-chat-delivery.js --execute --output=/tmp/oracle-inventory-multiline.xlsx
```

The diagnostic refuses submission if deployment ancestry or typed routing cannot
be verified. It prints sanitized stages/codes, request/job IDs and the normal
authenticated download path; it never prints credentials or upstream bodies.
Workbook checks cover native resolved location IDs, status/tag eligibility,
numeric quantities, strict thresholds, totals and ordering. A partial export
retains its coverage flags and exits 2. Local/browser fixtures use mocked Shopify;
only a successful deployed execution verifies live delivery. No live deployment
or current qualifying population is inferred from passing fixture tests.

## Storage projection (0c52483a)

Request `0c52483a-f6a6-4060-a080-4d6191375fd8`, job
`fc1be9f9-d862-4284-a38e-520a2689b5f4`, revision
`c4abb94afdde89401e110e03f9bb61f209380c25` completed retrieval and workbook
generation, then failed at `inventory_export_size` (reported deployed evidence).
That guard precedes the export-store write and the evidence callback/checkpoint;
workbook bytes exist only in process memory at that stage. It does not write a
local XLSX. A retained job/export lookup must be attempted before deciding a new
Shopify read is necessary. This workspace's read-only incident lookup returned
`EGRESS_FORBIDDEN`, so deployed recovery remains unverified; no live replay was
performed. An owner-scoped Render lookup command was provided separately.

The previous artifact embedded full location evidence for every scanned variant
while its first two workbook sheets already contained only qualifying variants.
The `Variant selection` sheet additionally retained all scanned variant totals.
Filtered exports now project qualifying variants before workbook construction.
Coverage retains evaluated/qualified/nonmatching/unknown counts, state counts,
and a SHA256 fingerprint of the scanned inventory; the fingerprint is provenance,
not an independent proof of omitted stock. Original catalogue eligibility audit,
status counts, tags, request count, native location bindings, retrieval interval,
limits and **all** failures remain. Qualifying rows retain their full product,
variant and native location quantities/timestamps for predicate and cell checks.
There is no per-variant quantity audit for omitted nonqualifying rows in the new
artifact. Coverage states this retention scope; old artifacts remain readable.

The shared BigQuery export adapter rejects serialized JSON over 8,000,000 bytes
before issuing its parameterized DML request. This leaves headroom for the
BigQuery 10 MB request bound and other request fields. Both existing guards stay
at 8 MB. A legitimately larger qualifying export still fails explicitly: there
is no result truncation or automatic provider replay. Measurements log total
JSON bytes, each envelope component, workbook raw/base64 bytes and other package
metadata, without product data or credentials.

The synthetic regression uses 553 eligible parents, 9,322 variants, six catalogue
pages and four required stores: 1,308 mocked reads. Its old envelope is 9,827,773
bytes (9,774,362 product/variant bytes), and its XLSX is about 275 KB raw/367 KB
base64: about 10.19 MB total. Projection retains 131 qualifying variants and a
211,160-byte envelope; XLSX is about 60 KB raw/80 KB base64: about 293 KB total.
ZIP timestamps can vary exact workbook byte counts. These are fixture
measurements, not reconstructed byte measurements of the failed live package.

The regression exercises production durable job and export SQL adapters over
JSON transport doubles, authenticated download/checksum/cells, unauthorized
access, persisted-artifact recovery without repeated reads, partial coverage,
unknown/unstocked/untracked states and preserving every qualifying row. Actual
BigQuery SQL execution and fresh live delivery remain separate deployed checks.
