# Product views before purchase

Run this **read-only production discovery first**; it only queries `INFORMATION_SCHEMA` and does not create or update data:

```sh
npm run discover:product-views
```

The deployment command remains `npm run discover:product-views`. It uses the shared BigQuery client configuration (`GOOGLE_SERVICE_ACCOUNT_JSON` when configured, otherwise Application Default Credentials), `GOOGLE_PROJECT_ID`, and `GA4_DATASET`. Dataset metadata determines query location; `GA4_SESSION_EVENTS_LOCATION` is only the fallback for a dataset that does not yet exist. Missing optional session-event configuration is reported by variable name, never by credential value. An authentication failure happens before evidence collection and therefore establishes nothing about historical product-view availability; do not create credentials or change Render configuration unless a configuration audit shows the existing value is actually missing.

Oracle must not claim availability until this reports a session-level schema and production coverage. Existing GA4 daily/funnel exports and Shopify analytics aggregates can support product-view event counts per period, but cannot establish event order or product identity inside a purchasing session. Dividing product views by purchases is therefore forbidden. Historical browsing cannot be reconstructed from orders.

The governed metric is **distinct nonblank product IDs viewed strictly before the earliest purchase timestamp within the same `user_pseudo_id + ga_session_id` session**, averaged over purchasing sessions. Repeated views of one product count once; missing product IDs are excluded and disclosed; sessions without purchases and views at/after purchase are excluded. The output is aggregate-only. Consent denial, blockers, bot/internal-traffic configuration, and actual observed coverage must be disclosed.

The fixed comparison is 2026-01-01 through the original request date (2026-09-30), versus the last Woo year 2024-11-20 through 2025-11-19. The confirmed public Shopify launch is 2025-11-20. Collection enabled later can answer future periods but does not repair unavailable history.
