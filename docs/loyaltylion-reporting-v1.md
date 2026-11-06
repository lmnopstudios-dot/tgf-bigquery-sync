# LoyaltyLion reporting v1 — review gate and manual pilot

This change adds retained-evidence reporting for current membership/current tiers, dated signed points movements, observed reward claims and exact Shopify customer/order linkage. It adds no scheduler or startup collection. Reporting and collection are off by default. The committed account configuration is unverified and contains no credential or approved initial-sync plan.

## Access review remains required

The committed account configuration is intentionally unverified. Before any collection, an operator must review account permissions, site/merchant-ID correspondence, retained warehouse/export evidence and dataset locations. An unavailable credential or inaccessible object is not treated as evidence of no data. Production diagnostic output, account identifiers, warehouse counts, knowledge records and credentials are excluded from this public PR.

## Supported contracts and limitations

LoyaltyLion Admin API v2 customer snapshots and immutable transactions supply the evidence. [Customers](https://developers.loyaltylion.com/api-reference/v2/resources/customers/list-customers), [Transactions](https://developers.loyaltylion.com/api-reference/v2/resources/transactions/list-transactions), [API keys](https://help.loyaltylion.com/en/articles/11581435-api-keys).

Current balances are stocks, not historical earned points. Pending-to-approved transfers retain both signed deltas; they are not double-counted as earnings. Immutable transaction conflicts fail promotion. Customer/transaction IDs reject unsafe JavaScript numbers and preserve string IDs. Reporting strips emails, birthdays, notes, codes, gift-card credentials and session tokens.

Membership is a complete observed roster, including non-purchasers, with enrolled/guest/blocked flags. It does not reconstruct historical membership. Current tiers are never treated as tiers at order time. Aliases are not merged into a new customer graph.

Claims are distinct claims dated by `claimed_at`. They are not actual reward use. Claims without point movements may be missing from transaction evidence, so claim completeness remains unverified. Usage timestamps/order associations require additional supported evidence. The [official export documentation](https://help.loyaltylion.com/en/articles/5367139-exporting-your-data) lists rewards, points-accounting and other exports; it does not verify this account's access. Current customer export-job metadata is separate from the full historical dashboard export catalogue.

Linkage uses exact same-shop customer/order GIDs after reviewed merchant-ID correspondence. It reuses the customer provider's qualifying-order predicate for statuses, positive remaining value, cancellations and Matrixify exclusion. It counts distinct linked qualifying orders once, retains unmatched/ineligible and ambiguous records, and reports their full denominators before channel/currency selection. It creates no finance sales total or new identity merge. It does not link by email, name, amount, timestamp or order-number similarity.

The linkage report is a cohort of point transactions in the selected London window, grouped by their original order date, recorded channel and presentment currency. It is not all member purchasing, programme uplift, LTV or a refund-event period report. Old orders linked to new points remain old orders. Purchasing-value and historical-tier requests are not satisfied by this linkage count. Shopify coverage is unverified even when points coverage is complete.

The recorded-channel helper positively distinguishes Online Store and POS; other sources stay unknown. Unknown currency stays separate. Missing finance/customer/location evidence does not turn a record into a native eligible purchase. No Woo or migrated Shopify copy becomes an additional sale.

## Read-only access verification

After this code is available in the normal checkout, this command reads only account identity/scopes, site metadata and at most five existing **customer-export job metadata** entries:

```sh
npm run verify:loyaltylion-access
```

It never creates or downloads an export and never reads customer records. It allowlists output fields and omits signed URLs, codes and credential values. An inaccessible endpoint is unavailable access; an accessible empty export listing is only an empty listing for that API/credential. It says nothing about tier-history/rewards export entitlement in the dashboard. If the key is still missing it makes no network call. Do not paste credentials into chat.

Required before approval: confirm `read_customers` and `read_orders`, program/site/Shopify correspondence, actual export options/MFA, dataset location, existing retained files, and the proposed pilot scope/count caps. No write or `all` scope is requested. The reporting GET client contains no mutation API or export-creation method.

## Concrete initial-sync proposal — not approved

`config/loyaltylion-initial-sync-proposal.json` proposes:

1. One complete **current** customer roster, observed at retrieval; it is not a roster for a past date.
2. Immutable point transactions for **1–5 November 2026**, London time: `2026-11-01T00:00:00Z <= created_at < 2026-11-06T00:00:00Z`.
3. Reward claims observed in those transaction responses, retaining their original claimed time and explicit usage/completeness limitations.

Counts are unknown. Hard caps are 40 API attempts, 30 pages/resource, 10,000 rows/resource, four requests/second, two retries, 120 seconds of vendor-client elapsed time, and 4 MB normalized payload/resource. A cap, malformed page, unsafe ID or repeated cursor fails the resource; it does not certify partial pagination as complete or advance its checkpoint. Retry-After is honored within the time cap. Old source history is not automatically backfilled and limits are never raised automatically.

The default command prints the inert plan without any source/warehouse access:

```sh
npm run plan:loyaltylion
```

Approval requires a versioned change to `config/loyaltylion-account.json`: actual reviewed account/program/site/shop/domain, verified merchant-ID mapping, reviewer/time, and the exact separately reviewed `initial_sync`. Merely copying the proposal is insufficient. Config must remain unreviewed until these findings are resolved.

Only after review and separate deployment authorization would an operator provision the destination dataset/ACLs in the verified Shopify region, then explicitly set `LOYALTYLION_COLLECTION_ENABLED=true` and use `node loyaltylion/sync.js --setup --apply`. The collector itself never creates datasets or implicitly provisions tables. Actual collection additionally requires an explicit `--apply`. None of those actions was executed for this PR.

A warehouse singleton guard is initialized only during explicit setup and updated transactionally to serialize executors. Each resource promotes data, successful coverage and checkpoint in one transaction while asserting guard ownership. Unknown acquisition/commit results retain the guard; there is no expired-lock takeover or automatic retry. Inspect the same holder/run and terminal query evidence before recovery. Successful resources survive a later resource failure; unattempted resources are explicit. Ordinary ingestion never deletes or truncates retained tables.

After the pilot, review roster/transaction counts, dates, exact-link coverage and sample aggregate reconciliation. Only then propose the next explicit overlap/window. Checkpoints record progress; they do not authorize automatic history or scheduling.

## Oracle delivery and tests

`get_loyalty_report` has one production provider shared by direct agent tooling, deterministic chat and durable jobs. Persisted `loyalty_scope` retains section, programme, current/historical tier basis, tier filter and claim/use intent. Date/grain/channel/currency changes remain in the shared analytical plan; incompatible results cannot satisfy a changed request. Unsupported section filters are explicit rather than silently dropped. Reporting requires reviewed configuration plus `LOYALTYLION_REPORTING_ENABLED=true`; it never calls vendor APIs.

Examples: “Show LoyaltyLion overview for October 2026”; “Show LoyaltyLion points daily for October 2026”; “Only Gold”; “Show linkage online and POS separately”; “Now use historical tiers”; “Export those results to Excel”. Historical tiers and actual reward use return limitations. A failed section leaves independent results visible. XLSX uses the normal retained-evidence integrity, privacy, owner-scoped download and expiry checks; export/render/recovery never replays providers.

Validation includes unit contracts, executed generated SQL on synthetic tables, real HTTP chat/direct/durable requests, request idempotency, partial failures, retained XLSX downloads and presentation failure recovery. The acceptance matrix and desktop/mobile browser gate are extended. Local fixtures are not live acceptance. No production balance writes, source collection or deployment is part of this change; keep the PR draft until access and required gates are resolved.

## Validation record for this draft

The offline acceptance gate passed with 1,112 tests and 15 optional-dependency skips. The new focused suite separately ran its generated SQL fixture with DuckDB/SQLGlot installed; all 21 focused tests passed without skips. Those are synthetic results, not production access verification.

The local browser gate could not start Chromium: `socket() failed: Operation not permitted`. Attempts to obtain the official headless-shell test runtime also failed at download. The committed CI workflow runs the required browser gate on the PR; browser acceptance is not claimed until that finishes successfully. An expanded optional-SQL run additionally reproduced the existing Bank Holiday SQL fixture failure on unchanged main (`GBP 999` versus expected `10`); that source/report/test is outside this PR and was not changed to mask it.

This release supports one verified Shopify site per LoyaltyLion programme. Multi-site programmes fail before customer collection because their merchant-ID correspondence has not been implemented. Period comparison metrics and purchasing-value analytics remain unavailable; primary evidence is retained with that limitation. No automatic collection or deployment follows from merging or completing a report.
