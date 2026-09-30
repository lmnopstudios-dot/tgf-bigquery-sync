# Oracle Shopify device × source conversion incident

Before this change, the dedicated model-facing tool was a **pre/post platform comparison** requiring four `before_*`/`after_*` arguments. Replaying the requested single Shopify window through that exact helper with `start_date` and `end_date` produced the sanitized failure `dry_run:oracle_boundary` / `oracle_boundary dry-run failed`; it did not establish that the joint Shopify table was absent. The new governed route uses the existing Shopify-native joint table directly and never substitutes GA4 sessions or Shopify orders.

The exact first Render Shell command after deploying is:

```sh
npm run diagnose:oracle-shopify-device-source
```

It is read-only and bounded. It obtains the `shopify_data` location from dataset metadata, dry-runs both the stored-label inventory and the exact Oracle helper query, uses explicitly typed `DATE` bindings for 2026-06-01 through 2026-08-31 inclusive, and caps each query at 1,000,000,000 bytes. Its failure result says retrieval failed rather than asserting absent evidence.
