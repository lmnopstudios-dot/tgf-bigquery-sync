# Oracle current-stock timeout

## Demonstrated findings and remaining incident unknowns

Request `b0c55e23-25e9-4436-9b89-d7769bf6e233` asked “What is the current stock levels for eye rings?” on revision `88a2dec19d87fdc41b90b88187d77fbe320d198d`. Supplied production evidence shows an interactive request, null deterministic subject/route/dates, a successful 195,693-byte catalogue search, a successful initial model round, inventory failure after 73,949 ms, UI timeout after 74,011 ms, and no time for final synthesis. This establishes the failed stage, not a specific Shopify error, query, product ID, permission failure or throttle event.

Inspection of that revision demonstrates these contributors:

- `searchShopifyProducts` returns up to 25 parents, each with up to 100 variants, including prices, aggregate quantities and catalogue metadata. The exact ordinary stock request had no deterministic stock route, so this large response went through model product resolution and another round of tool selection.
- The live inventory tool rediscovers products, paginates each parent's variants, then retrieves and paginates `inventoryLevels` separately for each variant, with two workers **inside each serial parent loop**. It fetches other locations before filtering to one resolved location. At least one level request per variant is necessary in that implementation, rather than one batch per relevant inventory-item/location set. Variant and inventory-level pagination have no maximum page/request count.
- Tool admission reserves synthesis time only before dispatch. The live inventory provider receives no explicit provider deadline; its fetches inherit the whole request signal, so an admitted long retrieval can consume the reserved answer time. OAuth also lacked the cancellation signal. Its underlying calls do not have individual time limits. An outer UI/agent timeout cannot guarantee a final answer after retrieval.
- The separate historical inventory provider already batches Product and InventoryItem `nodes`. It is reused here. Its former 20-parent × 100-variant nested query could also exceed Shopify's requested-cost ceiling; the shared query is reduced to five parents × 20 initial variants.
- OAuth/GraphQL error logging could print upstream bodies and raw exceptions. The changed transport retains status and bounded native codes/cost metadata, without private messages or catalogue payloads.

The original tool's **actual arguments**, product/variant IDs, individual HTTP timings, native permissions, throttle/cost events and error response have not been recovered. Whether production “eye rings” has an active governed product group or only catalogue candidates remains unverified. No incident-specific root cause beyond the inventory timeout is claimed.

## Implemented behavior

Ordinary stock questions, including the exact request, resolve `current_stock` without historical dates and reset unrelated analytical scope. The shared direct, interactive and durable paths call the same service. Other analytical questions retain their existing fallback, product selection, exports and charts.

Resolution first reads the existing active/effective `product_group` classifications in `commerce.product_classifications`, matching `eye_rings` or `eye_ring`. This is one read query, no setup/sync/knowledge writes, at most 26 rows, 100 MB billed and a 5-second BigQuery job timeout. When no group resolves, Shopify discovery returns only product ID/title/handle/status, with one 25-parent page and explicit truncation/ambiguity handling. Title candidates are explicitly distinguished from governed group membership. Inventory is bound to those Product IDs; a clarified offered product is bound to its validated ID. No whole-store inventory read occurs.

The shared reader batches product metadata and inventory-item lookups at resolved locations. Its historical callers and existing model tool retain their strictly configured single-location contract. Ordinary stock questions without a location show separate active locations, capped at ten. An explicit location uses the existing exact configured/name selector. Missing levels remain null, never zero. `available`, `on_hand` and `committed` remain separate. Tracked/untracked status, variant policy, purchasability and made-to-order tags are preserved; none establishes readiness to ship, production capacity or component/stone availability.

Limits:

| Limit | Bound |
| --- | --- |
| Current-stock service | 45 seconds, further shortened by the caller's remaining deadline |
| Individual auth/GraphQL call | 8 seconds or remaining deadline, whichever is smaller; AbortSignal propagated |
| Resolution / inventory request attempts | 4 / 36; retries count against those bounds |
| Concurrency | 2 |
| Retry | At most one per throttled call; no credential, permission or arbitrary-error retry |
| Throttle delay | At most 2 seconds, and only with room for another request |
| Parent population / parent batch | 25 / 5 |
| Variant pages per parent | 5 total: initial 20, subsequent pages 50 |
| Retained variants / item batch | 500 total / 50 |
| Location pages / returned active locations | 2 pages of 100 / 10 |
| Main answer table | 60 rows; remaining returned rows in Show details |

Complete, partial, unavailable and failed evidence have distinct contracts. Observed rows survive other parent/page/location failures. Failed and missing quantities stay unavailable, while explicit zero and negative available quantities remain visible as shortages. Observation times are recorded after each level batch, shown in the summary/table and preserved in job storage. Recovery shows a stale warning after 15 minutes; this is a disclosure threshold, not a promise of Shopify freshness. No stored inventory collector/snapshot is substituted for a current live read.

Stock answers are deterministic and do not need final model synthesis. The general tool path explicitly subtracts the existing synthesis reserve before inventory. Durable execution uses the same bounded query, and checkpoints the answer/evidence before later delivery/proposal work. Recovery reads saved evidence rather than re-querying Shopify. Durable execution is suitable for disconnect/recovery or bounded partial results; it does not authorize larger query budgets or remove query inefficiency.

The business answer leads with an observed available-unit summary and product/variant/location table. Shortages, incomplete coverage, untracked inventory, made-to-order/backorder status and old observation times remain visible. Definitions, source IDs, page/request/timing counts and sanitized stage/code/HTTP/cost diagnostics are in Show details. No credentials, customer data, full catalogue payloads or raw private exceptions are logged.

## Local verification versus live acceptance

Local fixtures execute the actual shared direct entrypoint and authenticated interactive/durable HTTP implementations, with instrumented Shopify calls. They assert the exact query variables, relevant parent/item/location IDs, bounded call counts, cancellation, pagination, throttling, partial failures, 401/403 handling, untracked/MTO/backorder semantics, product clarification, observation times and durable checkpoint/recovery. Fixture IDs and permission grants are **not production evidence**.

Focused command (requires localhost socket permission in the task sandbox):

```sh
node --test --test-isolation=none test/oracle-current-stock.test.js test/shopify-inventory-by-location.test.js test/oracle-analysis-context.test.js test/oracle-analysis-route-dispatcher.test.js test/oracle-answer-presentation.test.js test/oracle-general-analytics.test.js test/oracle-product-selection-http.test.js test/oracle-product-report.test.js test/oracle-product-priority.test.js test/oracle-inline-charts.test.js test/oracle-analysis-jobs.test.js test/oracle-tool-schemas.test.js test/oracle-request-tool-budget.test.js test/historical-product-opportunity.test.js
node diagnostics/oracle-tool-schema-validation.js
git diff --check
```

The completed full `node --test test/*.test.js` run passed 967 of 970 tests with three existing environment-gated skips, zero failures and zero cancellations. The final focused run is recorded in the PR. Initial localhost `EPERM` failures were rerun with socket permission and are not counted as passes.

A bounded live provider diagnostic was attempted from this branch. It failed during authentication transport, before group/product/variant/inventory reads, with no Shopify HTTP response. This environment's enforced host allowlist excludes Shopify; configured credential readiness does not establish API access. Production permissions, IDs, quantities, classification availability and live performance are therefore **not accepted**. No collector, inventory refresh, backfill, stock mutation, knowledge edit, schedule change, deployment or merge was performed.

## Exact bounded production acceptance steps

Run these once in an approved runtime that can reach the configured Shopify shop and Google APIs. Keep the inherited proxy and TLS trust; in this managed Node 24 environment use `--use-env-proxy`. Do not bypass a denied destination. Use the existing secure runtime variables; never put secrets in commands, logs or issue bodies.

1. Check out this PR commit in an isolated approved read environment. Run `node --use-env-proxy diagnostics/oracle-current-stock.js`. It accepts **no arguments** and reads only the exact eye-ring request through the shared provider. It performs authentication and one current-app scope probe, then one bounded group lookup and the bounded resolver/reader above. The preflight allows three attempts; service allows at most 40 attempts, so the whole invocation has an upper bound of 43 auth/GraphQL attempts, a shared 45-second deadline and one bounded BigQuery query. It never calls a collector or writes source data. A failed preflight stops before inventory. Save only its sanitized output.
2. Require successful live evidence or a relevant, explicit clarification/limitation. Record the actual `resolution.method`, product/variant/inventory-item IDs, resolved/observed locations, native granted `read_products`/`read_inventory`/`read_locations` scopes (absence is not proof of an equivalent write scope being absent), HTTP status/cost/throttle metadata, page/request counts and actual observation times. Inspect quantity meaning/coverage, untracked/MTO/backorder flags and shortages in the provider result. Do not interpret a failure, absent row or untracked item as zero.
3. **Only after a separately authorized release containing this commit** (this task does not deploy), submit the exact message once to the existing bearer-authenticated `POST /agent` with a fresh `x-request-id`, `deadline_at` equal to now + 60,000 ms and `durable_job:false`. Use a secure HTTP client with the existing `SYNC_SECRET` bearer header and a 65-second client timeout. Require `evidence.subject=current_stock`, no dates, a relevant inventory summary/table, matching IDs and bounded diagnostics. Do not repeat the old inefficient request on revision `88a2dec` to try to infer its original failure.
4. In a fresh authenticated Oracle browser session, submit the same exact message once via interactive `POST /api/oracle/chat`. Allow at most 65 seconds. Verify the summary/table and Show details, separate locations/quantities, observation times, shortages and incomplete/untracked/MTO flags. This path must not ask for historical dates or return a sales/customer report. Compare identity/coverage semantics with step 3; exact quantities may change between observations.
5. In another authenticated session, submit the message once via `POST /api/oracle/jobs` with a fresh request ID. This creates only a normal Oracle job. Poll its owned `GET /api/oracle/jobs/:id` at most 12 times, five seconds apart, with a five-second timeout per read; stop after 60 seconds or a terminal status. Refresh/reconnect and read the same job twice; require the same saved IDs/observation times, with no new provider read. If unfinished, cancel that **same job** once using the existing authenticated CSRF-protected cancel endpoint; do not create another job. A persisted partial/failed-delivery result must remain readable with its limitation and actual observation time. Do not induce production credential failures or corrupt job storage to test recovery; those faults are fixture-tested.

Stop at any missing network/IAM/runtime prerequisite and record the sanitized stage/code/status. There is no acceptance step that collects stored inventory, adjusts stock, edits knowledge/schedules, backfills, merges or deploys.
