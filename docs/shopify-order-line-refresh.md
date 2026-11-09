# Shopify order-line refresh

This collector owns only `shopify_data.order_line_items` and its independent
`order_line_refresh_state` watermark. The finance and catalogue jobs stay as
they are. Do not run the legacy full-table `/sync-shopify` rebuild once this
collector owns the line table.

## Bounded backfill

From a reviewed checkout with the existing Shopify and BigQuery credentials:

```sh
node shopify/order-line-refresh.js backfill START_UTC END_UTC ONLINE_COUNT POS_COUNT
```

Preview reads Shopify and BigQuery but writes nothing. It compares the captured
lines against the eligible order IDs and supplied channel counts in finance.
It prints aggregate missing-order counts and lines without parent IDs. If
counts differ or an eligible order has no lines, it exits without promoting.
Supply UTC timestamps for the requested half-open reporting window, at most four days.

After approval, run the same bounded read, reconciliation and transactional
promotion with:

```sh
node shopify/order-line-refresh.js backfill START_UTC END_UTC ONLINE_COUNT POS_COUNT --apply
```

This does not advance the scheduled watermark. Run the product ranking query
after the commit and retain its coverage output. A bounded backfill does not establish coverage outside its window.

## Render configuration to prepare after review

| Setting | Value |
| --- | --- |
| Service type | Cron Job, Node |
| Name | oracle-shopify-order-lines |
| Build | `npm ci` |
| Command | `node shopify/order-line-refresh.js scheduled --apply` |
| Proposed UTC schedule | `43 */2 * * *` |
| Credentials | Same Shopify and BigQuery configuration as the finance cron |
| `SHOPIFY_ORDER_LINES_BOOTSTRAP_UTC` | Reviewed UTC start for the scheduled update window |
| `SHOPIFY_ORDER_LINES_ENABLED` | Leave unset or false until explicitly enabled |

No active Render Blueprint entry is included. Each scheduled run processes at
most one day of forward update history with a two-hour lookback. The five-minute
delay reduces exposure to Shopify search indexing lag; it does not certify
complete source history. Orders and nested lines paginate independently; a
cursor, request, elapsed-time, row or encoded-size bound stops the run before
promotion. A repeatedly oversized scheduled window needs a reviewed adjustment,
not a watermark jump.

BigQuery validates temporary staged rows, merges on order and line ID and
updates the watermark in one transaction. It does not delete old line rows.
Matched rows only accept a newer observation. The collector does not copy line
custom attributes or discount-allocation payloads; existing values are
preserved. The discounted line amount matches the existing Shopify field,
excludes shipping, retains source tax semantics, and is not refund-adjusted.
Shopify's field does not include all order-level/code discounts.
