# Oracle baseline KPI routing incident

## Observed route and failure propagation

The exact request `Can you give me an overview of current baseline KPIs` entered the
Oracle UI `/chat` handler, whose production `chat` adapter forwarded it to the
`/agent` endpoint. It did not match one of the deterministic conversion or
page-view routes. The model therefore selected from the complete tool registry.
The old prompt named the management-report-first route only for an “ecommerce
report”, “management ecommerce report”, or “ecommerce performance overview”; it
did not classify the phrase “current baseline KPIs”. Inventory tools were visible
in the same registry, so tool selection could incorrectly interpret a general
operating baseline as requiring current stock evidence.

The selected Shopify inventory tool raised `THROTTLED`. In the `/agent` tool loop,
that error had a special immediate `429 SHOPIFY_TEMPORARILY_RATE_LIMITED` return,
before other successful tool results could be synthesized. The UI transport then
converted that 429 into the single inventory rate-limit sentence. Thus an
optional, wrongly selected source suppressed every independent section.

## Corrected route

The exact prompt now has one deterministic orchestration shared by interactive
UI, durable worker, and direct `/agent` paths. It calls only these governed tools:

1. `get_sales_summary` for finance;
2. `get_shopify_conversion_kpis` for sessions and conversion;
3. `get_shopify_sales_kpis` for compatible operational orders and AOV;
4. `get_shopify_device_conversion_by_traffic_source` for the device breakdown;
5. `get_klaviyo_email_performance` for separately reported campaigns and flows.

There is no inventory call. Paid advertising is omitted unless a governed
collected-evidence service is explicitly supplied. Calls settle independently,
so one failed section is labelled unavailable while successful sections remain.
Missing evidence is never rendered as zero. The response labels each dataset's
reporting period and retrieval timestamp, and explicitly retains provisional
Klaviyo attribution and unresolved finance reconciliation.
