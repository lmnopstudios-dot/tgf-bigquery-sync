# Oracle ShopifyQL throttling

## Production incident trace

The observed request travelled from the Oracle browser `POST /api/oracle/chat`, through the UI router's `chat` adapter to the internal `POST /agent` endpoint. The model selected a Shopify inventory tool, which obtained an access token and called `runShopifyqlReport` and then Shopify Admin GraphQL's `shopifyqlQuery`.

Shopify rejected that operation with `THROTTLED`, `requestedQueryCost: 1000`, `currentlyAvailable: 779`, and `windowResetAt: 2026-09-24T17:14:00+00:00`. The previous implementation could sleep until a reset (up to 30 seconds per tool invocation), retry once inside `runShopifyqlReport`, return a retryable tool error to the model, and then accept the same model tool call again. The outer model/tool loop had no round limit or request deadline. Thus the observed roughly five-minute UI wait was not one intentional five-minute sleep: it could comprise repeated ShopifyQL waits/retries and model round trips before `/agent` finally failed and the UI reduced that failure to “The request could not be completed.” Historical logs are not precise enough to assign milliseconds to each model round.

The 1,000 cost is consistent with the broad `FROM inventory` efficiency query: it requests all inventory metrics, groups across the catalogue by product, and has no product predicate. The evidence identifies the rejected query cost but not the tool name, so this is a code-path diagnosis rather than a claim recovered from a logged query. Clearance follow-ups should prefer exact product catalogue searches and exact-location live inventory calls. Historical aggregate inventory should be narrowed to the smallest useful window and not repeated when recent governed evidence is already available.

## Bounded policy

* Oracle gives an internal chat request at most 90 seconds and reserves 10 seconds to return a terminal response.
* A ShopifyQL throttle is retried at most once, only after Shopify's valid reset time, only when the wait is at most 45 seconds, and only when it fits before the request deadline plus the response reserve.
* A reset outside that budget returns HTTP 429 and the safe terminal message “Shopify inventory analysis is temporarily rate limited. Please try again shortly.”
* Identical tool name/argument calls are rejected within a request, and the outer model/tool loop is limited to eight rounds.
* Diagnostics contain only operation, elapsed time, retry count, requested cost, currently available capacity, reset timestamp, bounded wait/remaining time, and outcome. They contain no ShopifyQL text, products, inventory, model arguments, credentials, or upstream error body.

## Production acceptance (low-impact)

1. Deploy during normal traffic; do not run a synthetic expensive ShopifyQL query.
2. Confirm `/api/oracle/session` works, then ask one narrow catalogue-only question for a single known product.
3. Ask for that product's live stock at **one** exact location (Soho). Repeat separately for East and Los Angeles only if those locations are required; never request an all-location aggregate as a substitute.
4. Submit one follow-up that can use the immediately preceding evidence. Confirm the answer discloses evidence freshness and does not issue an unchanged tool call.
5. Observe ordinary logs for a naturally occurring throttle. Confirm there is at most one scheduled retry and that a reset outside the remaining budget promptly produces the inventory-specific terminal message.
6. Verify the browser replaces “Thinking…” with either the answer or that terminal message and re-enables Send.
7. For Rolling Stones stock, verify the answer preserves location-level quantities and requires human contract review before suggesting promotion, discounting, or scrapping.

This sequence uses narrow read-only calls and relies on a natural throttle to validate the failure branch; it does not deliberately consume Shopify query capacity.
