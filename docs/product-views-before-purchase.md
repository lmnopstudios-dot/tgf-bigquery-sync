# Product views before purchase

Run this **read-only production discovery first**; it only queries `INFORMATION_SCHEMA` and does not create or update data:

```sh
npm run discover:product-views
```

Oracle must not claim availability until this reports a session-level schema and production coverage. Existing GA4 daily/funnel exports and Shopify analytics aggregates can support product-view event counts per period, but cannot establish event order or product identity inside a purchasing session. Dividing product views by purchases is therefore forbidden. Historical browsing cannot be reconstructed from orders.

The governed metric is **distinct nonblank product IDs viewed strictly before the earliest purchase timestamp within the same `user_pseudo_id + ga_session_id` session**, averaged over purchasing sessions. Repeated views of one product count once; missing product IDs are excluded and disclosed; sessions without purchases and views at/after purchase are excluded. The output is aggregate-only. Consent denial, blockers, bot/internal-traffic configuration, and actual observed coverage must be disclosed.

The fixed comparison is 2026-01-01 through the original request date (2026-09-30), versus the last Woo year 2024-11-20 through 2025-11-19. The confirmed public Shopify launch is 2025-11-20. Collection enabled later can answer future periods but does not repair unavailable history.
