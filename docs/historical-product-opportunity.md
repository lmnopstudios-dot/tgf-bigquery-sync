# Historical product opportunity production acceptance

Acceptance question (submit verbatim through Oracle):

> Which historically strong WooCommerce products now have weak Shopify sales despite available Online stock?

This question must use the durable job route and the single governed
`get_historical_product_opportunities` result. The comparison uses Woo WW and
US from 20 November 2024 through 19 November 2025, native Shopify Online from
the confirmed public launch on 20 November 2025 through the stated end date,
and current exact-variant availability at Online. It accepts only approved
identity or reporting-family joins and excludes Matrixify representations.

## adf458f7 incident diagnosis

The former inventory implementation made one complete location-inventory API
request per mapped parent with concurrency two and no stage timeout. The
request-level tool timeout fired at roughly 300 seconds while that inventory
fan-out was still running; Woo sales, Shopify sales, and the mapping ledger had
already completed. The 162-byte value was the wrapper's tool error, not
analytical evidence. The subsequent provider `TimeoutError` occurred with
about 119 seconds of request budget left, so it is now classified separately
as a synthesis timeout with request budget remaining rather than a request
deadline.

Every run now records bounded timings for `woo_sales`, `shopify_sales`,
`mapping_ledger`, `inventory_retrieval`, and `joining_and_ranking`, including
the timeout ceiling and a sanitized error class/reason. Inventory parents are
requested in bounded batches with bounded concurrency. All batches are
attempted; if any batch fails, the result discloses incomplete coverage and
contains no ranked rows or zero-stock/zero-opportunity conclusion.

The first production action is the bounded, read-only location diagnostic below.
It lists at most 500 Shopify locations with only location ID, name, active status
and online-fulfilment eligibility. It also prints the configured selector and the
reason it did or did not resolve. It never reads customer data or prints Shopify
credentials:

```sh
render ssh --service <oracle-service> -- npm run diagnose:shopify-inventory-location
```

This is the exact first Render diagnostic command. Verify that the resolved ID,
name, active status and `fulfillsOnlineOrders` value identify the actual Online
fulfilment location before running the opportunity question. If production
already has `SHOPIFY_LOCATION_ID`, the resolver consumes that existing stable-ID
contract. `SHOPIFY_INVENTORY_LOCATION_ID` is the inventory-specific override;
either a numeric ID or a Shopify Location GID is accepted. With neither ID set,
`SHOPIFY_INVENTORY_LOCATION_NAME` is an exact, case-sensitive name selector and
defaults to exact `Online`. The resolver never guesses from a similar name.

Only after location verification, submit the exact acceptance question once:

```sh
render ssh --service <oracle-service> -- npm run diagnose:historical-product-opportunity -- --url="$RENDER_EXTERNAL_URL"
```

Do not approve Oracle acceptance until every staged count reconciles and the
command reports `valid: true`. The output reports WW and US independently for
the historical population, active identity and family decisions, eligible
mappings, and joined Woo coverage. It also reports distinct mapped Shopify
parents, parents with Online sales, exact-variant positive Online stock, and
each successive intersection. Failure examples contain only source/product
IDs and reasons—never order or customer data.

The earlier `12 / 35 / 25` result was not a production population. The product
report applied one global top-100 sales-row limit before the governed join, so
the 12 approved Woo rows and 35 Shopify rows were upstream members of that
mixed-source sample. The inventory loader independently requested the first 25
active products, making 25 explicitly a pagination sample. Neither sample was
keyed to the approved mapping ledger. The fixed read path reads active
`approved` identity decisions and active reporting-family decisions, verifies
their Woo source refs and Shopify parent refs, removes the global sales limit,
and requests inventory by every mapped Shopify parent ID.

Products without a Shopify Online sale row are now retained as observed zero
sales and can satisfy “weak sales”; they are not discarded before evaluation.
Inventory is joined at Shopify **product parent** ID, while availability is
computed only from exact child **variant** inventory at the Online location.
The join normalizes only Shopify's two representations of that declared parent
identity: a decimal product ID and `gid://shopify/Product/<id>`. It rejects
`ProductVariant` GIDs as parent IDs. The diagnostic prints the count after each
join plus bounded, non-customer identifier examples with their runtime type and
format, making a GID/numeric or parent/variant mismatch visible without creating
a match. Its mapping-read contract confirms that identity rows come from the
same `governed_active` (`approved`) state and family rows from the same
`family_active` (`active`) state used by Product Mapping.
Suggested, fuzzy, and deterministic catalogue matches remain a separately
visible coverage gap: the governance contract for this analysis permits only
active human-approved identity or reporting-family decisions, so the read path
does not promote them or create mappings.

Accept only `valid: true`, reconciled staged population and join coverage, separate
source currencies, and ranked rows that retain mapping provenance and the
positive exact variants. A synthesis failure is acceptable only when Oracle
returns that bounded joined table; an unrelated Shopify best-sellers list is
not an acceptable fallback. Neither mode modifies mappings or inventory. Live
mode creates only its durable execution record; offline mode only reads the
supplied capture.

## Candidate-first batched inventory retrieval

Sales and approved mappings are read first. The complete mapped Woo-sales population sets the historical top-quartile cutoff; weak Shopify sales (including candidates with no Shopify sales row, treated as observed zero sales) then select the only parents sent to live inventory. This preserves the sales ranking population while avoiding inventory calls for products that cannot be returned.

The production inventory helper uses Shopify GraphQL `nodes(ids:)`: one parent request per 20 parents and one inventory-item request per 100 variants. It fully paginates variants beyond 100, resolves the configured exact location ID (or exact-name fallback), requires it to be active and eligible to fulfil online orders, bounds concurrency at two, and waits at most once per call for a reported throttle reset only when the remaining deadline permits. Its credential-free aggregate diagnostic reports duration, requested/returned parents, variants, actual network calls by kind, pages, throttle waits, and coverage. It is live data: `inventory_as_of` is emitted, and incomplete coverage produces no ranking and is non-retryable within the analysis.

The exact first Render command is:

```sh
render ssh --service <oracle-service> -- npm run diagnose:shopify-inventory-location
```

After it verifies the actual Online location, run the historical-product command
shown above. Mocked tests prove only the selection, batching, pagination,
throttling, and failure contracts; they do not establish production success.
