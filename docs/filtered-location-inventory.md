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
timestamps, failures and limits. Variant selection and product eligibility audit
sheets record excluded and unknown rows explicitly. An empty result retains the
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
