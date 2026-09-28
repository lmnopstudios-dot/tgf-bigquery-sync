# Historical product opportunity production acceptance

Acceptance question (submit verbatim through Oracle):

> Which historically strong WooCommerce products now have weak Shopify sales despite available Online stock?

This question must use the durable job route and the single governed
`get_historical_product_opportunities` result. The comparison uses Woo WW and
US from 20 November 2024 through 19 November 2025, native Shopify Online from
the confirmed public launch on 20 November 2025 through the stated end date,
and current exact-variant availability at Online. It accepts only approved
identity or reporting-family joins and excludes Matrixify representations.

Save the returned tool JSON without editing it, then run the read-only check:

```sh
npm run diagnose:historical-product-opportunity -- --result=/path/to/result.json
```

Accept only `valid: true`, visible evidence-size and join coverage, separate
source currencies, and ranked rows that retain mapping provenance and the
positive exact variants. A synthesis failure is acceptable only when Oracle
returns that bounded joined table; an unrelated Shopify best-sellers list is
not an acceptable fallback. This diagnostic reads the supplied capture only;
it does not modify mappings, inventory, or production data.
