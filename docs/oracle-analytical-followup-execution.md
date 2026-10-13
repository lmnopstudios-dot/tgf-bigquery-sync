# Shared analytical follow-up execution

## Demonstrated causes and changes

The supplied shipping conversation exposed missing execution capabilities, not just a presentation defect. The regression reconstructs the complete conversation with the production dependency factory, shared context, planner, dispatcher and authenticated UI implementations.

| Stage | Demonstrated defect | Change |
| --- | --- | --- |
| Parsing | Requested operations recognized bands/scenarios but omitted merchandise mean, median, basket gaps and break-even. Metric-only requests could miss the opening-verb continuation gate. | Semantic component detection works for fresh order-value questions and retained order-value scope, independently of opening wording. Source-native Shopify-reported AOV remains a different measure. |
| Context | The operation list was replaced wholesale by a newly recognized subset. Exclusion ranges could be interpreted as a replacement reporting window. Output/calendar-only refinements could clear components. | Shared component merging distinguishes additions/replacements and preserves compatible scope. Explicit exclusion ranges become comparison-calendar dates while the primary reporting window remains intact. |
| Planning | The supported order-value operation registry had no bindings for the new requested metrics. | Mean/median and exact threshold-relative gaps have order-grain bindings. Break-even remains conditional. Components have explicit execution outcomes: supported, conditional, failed or unavailable. |
| Execution | The numeric engine produced bands, changed-eligibility scenarios and baseline-only 10–75 gaps; it did not calculate exact mean/median or per-threshold 10/25/50 gaps. | Exact weighted merchandise statistics use equal-value groups from unique-order snapshot SQL. Merchandise subtotal is retained independently even when scenarios use observed total. Valid-value denominators and unknown counts accompany statistics. |
| Price retrieval | Transport errors lost authentication versus GraphQL stage, network reason, HTTP status and bounded query locations. Price retrieval unnecessarily required classification/collection metadata. | Sanitized allowlisted diagnostics survive transport, catalogue, evidence and rendering. The price binding requests published products and destination variant prices without classification, collection-pagination or inventory prerequisites. |
| Rendering/export/recovery | Newly requested components had no calculated fields or visible outcomes. | Both full-period and sale-excluded results include statistics, gaps, disclosed shipping denominators and outcomes. XLSX has dedicated statistics, component and formula sheets. Validated recovery regenerates presentation without provider calls. Legacy reports can recover their original operations but cannot answer newly requested metrics. |

## Measures and limits

- Mean is the exact weighted sum of valid observed merchandise subtotals divided by their order count. Median selects the middle weighted rank(s), without band centres or distribution estimation. Source-ambiguous stored zero remains unknown; independently established zero is valid. Currency display rounds to two decimal places; evidence retains calculated precision.
- Historical merchandise AOV does not change between threshold scenarios. Merchandise subtotal excludes shipping; tax inclusion remains unverified. Current published prices are separate evidence and do not reconstruct historical baskets, shipping qualification, inventory availability or validated cross-sell relationships.
- For each threshold `T`, gap is `T − observed amount`. Gap intervals are `(0,10]`, `(10,25]`, `(25,50]`, with cumulative within-10/25/50 counts. Equality at `T` qualifies and is excluded from positive gaps. Unknown amounts are counted separately.
- Recorded shipping potentially forgone is the partial sum of known recorded charges on retrieved orders with known amount `>= T`. Per-order arithmetic divides by **all** such eligible orders, including unknown-charge orders. Known/unknown charge counts and denominator are explicit. These conditional numbers do not verify the shipping-rule basis or predict lost revenue.
- Break-even formulas disclose required contribution margin/product costs, fulfilment costs, incremental merchandise order value and eligible session inputs. Explicit user-supplied sensitivity assumptions may support arithmetic but are unvalidated. The result exposes formulas and missing inputs; it does not invent sensitivity assumptions or calculate forecasts. This implementation does not claim a behavioural forecast, causal conversion uplift, or optimal-profit threshold.
- The existing population is collected Shopify history, using direct destination/currency, unique latest component snapshots, the governed online proxy and financial eligibility predicates. Authoritative population completeness, tax/shipping-rule semantics and cross-platform combined order distributions remain unverified.

## Related report audit

The shared addition/replacement helper is used for order-value operations, weekday native metrics and product-report metrics. The audit found two related failures: weekday requests captured only the first unsupported metric; product additions prefixed with conversational wording could replace earlier columns. Regressions assert the full weekday metric list and retained sale context, plus actual product units/landing-session/organic-click calculations after multi-metric additions. Sorting changes preserve existing columns and compatible evidence snapshots.

Other existing governed subjects (ordinary sales, weekday sales, Klaviyo and device conversion) now retain their scope for generic new analytical components and explicitly reject unbound operations instead of executing an old report as their answer. Existing campaign purchase/revenue, native sales baseline, product-report and social report regressions remain part of full-suite verification. Source-native Shopify AOV is not relabelled as exact observed merchandise AOV.

## Verification

`test/oracle-analytical-followup-execution.test.js` checks:

1. Initial full-period and May-sale-excluded shipping result, followed by new AOV/median/gap/price/break-even operations through real shared context, dispatcher and direct agent.
2. Exact full-period mean `1474.99 / 6`, median `237.495`, six valid and one unknown merchandise amount; excluded-period mean `1074.99 / 4`, median `249.995`, four valid and one unknown amount.
3. Static AOV across thresholds, exact monetary boundaries, odd/even weighted medians, invalid values, observed-total/subtotal separation, shipping sums/denominators and visibly failed price components.
4. Authenticated interactive chat and lease-owned durable jobs/polling, owned XLSX downloads, manifest recovery, browser-consumed result contract and scope rejection after evidence tampering.
5. Outcome/statistic/gap/row/formula scope validation, chart exclusions, presentation recovery without another provider call, legacy-report refusal for new metrics, and partial delivery when every merchandise amount is unknown.
6. Sanitized production-shaped GraphQL HTTP-200 failure, bounded locations and destination-price query binding without inventory or collection requests.
7. Add-versus-replace and calendar-only refinements, cross-subject unsupported-component outcomes, and actual multi-metric product-report execution.

Existing order-value population tests execute the production snapshot/aggregate SQL through the SQLite compatibility harness; date-binding/retrieval tests exercise the real BigQuery SDK parameter serializer. No tests or diagnostics collect/backfill data, mutate source/knowledge, query inventory, change schedules, deploy or merge.

Full repository verification passed: `npm test` reported 1,222 passed, zero failures and three opt-in live checks skipped (1,225 tests). The final unavailable-values/partial-delivery adjustment was subsequently verified by 54 focused conversation, calculation and multipart tests, all passing.

Earlier focused runs passed: 30 tests covering the new conversation suite, order-value calculations and sanitized retrieval; 37 tests covering conversation, order-value selection and calculations; 103 related context, clarification, multipart and UI tests.

## Live checks still required

A bounded live call to the configured published-price factory failed before catalogue pages or GraphQL execution: `SHOPIFY_AUTH_NETWORK_FAILED`, no HTTP response, zero pages/products. Direct fetch exposed `EAI_AGAIN`; the configured environment-proxy path aborted its connection (`UND_ERR_ABORTED`). These are task-environment authentication-connectivity observations, not proof of the original production provider's GraphQL failure. No provider body, credential, token or shop identifier was logged.

After connectivity is restored, run the bounded published-price query through the real production identity and retain the now-sanitized authentication/GraphQL details. Verify the actual returned variant-price coverage and any provider query/binding rejection before changing the query further. No production GraphQL binding defect was demonstrated by this environment's live probes.

Also verify the new merchandise projection against live BigQuery schema and coverage using bounded read-only diagnostic/dry-run controls, and run the complete conversation in the deployed browser once this PR is separately approved for deployment. Local authenticated HTTP/polling/recovery tests do not establish live browser delivery. Deployment is outside this task's authorized scope.
