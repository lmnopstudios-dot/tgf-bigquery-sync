# Historical product opportunity production acceptance

Acceptance question (submit verbatim through Oracle):

> Which historically strong WooCommerce products now have weak Shopify sales despite available Online stock?

This question must use the durable job route and the single governed
`get_historical_product_opportunities` result. The comparison uses Woo WW and
US from 20 November 2024 through 19 November 2025, native Shopify Online from
the confirmed public launch on 20 November 2025 through the stated end date,
and current exact-variant availability at Online. It accepts only approved
identity or reporting-family joins and excludes Matrixify representations.

The first production action is read-only: run the exact acceptance question in
Oracle, download the single tool result as `/tmp/historical-product-opportunity.json`,
then open a Render shell and run:

```sh
render ssh --service <oracle-service> -- npm run diagnose:historical-product-opportunity -- --result=/tmp/historical-product-opportunity.json
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
not an acceptable fallback. This diagnostic reads the supplied capture only;
it does not modify mappings, inventory, or production data.
