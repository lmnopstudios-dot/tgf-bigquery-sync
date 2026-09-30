# Historical-opportunity durable worker

The web process and its in-process durable-job worker use the same inventory
location configuration contract as `diagnostics/shopify-inventory-location.js`:

1. `SHOPIFY_INVENTORY_LOCATION_ID` (preferred stable Shopify Location GID or
   numeric ID)
2. `SHOPIFY_LOCATION_ID` (legacy stable-ID fallback)
3. `SHOPIFY_INVENTORY_LOCATION_NAME` (exact-name fallback)
4. exact name `Online` only when none of the variables above is configured

At startup the service emits `Historical opportunity inventory configuration`
with the safe selector and deployed revision. Each resolution also logs the
selector and bounded Shopify location metadata; tokens and inventory values are
not included.

## Render deployment requirement

Set `SHOPIFY_INVENTORY_LOCATION_ID=gid://shopify/Location/105063874887` on **the
Render service that runs `node server.js` and claims Oracle durable jobs**, not
only on a diagnostic shell or a different service. Deploy the same committed
revision to that worker/service and verify its startup log reports
`configured_by: SHOPIFY_INVENTORY_LOCATION_ID`. If Render uses a separate
background-worker service, apply the variable there and redeploy it too. Do not
rename a Shopify location or change a governed product mapping to compensate
for missing worker configuration.

No backfill or production-data rewrite is required.
