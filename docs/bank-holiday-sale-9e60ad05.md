# Bank Holiday sale request 9e60ad05

## Retained incident, before replay

The operator supplied a bounded read-only Render extraction for request
`9e60ad05-9275-4a13-ade3-10148c03f56f`, job
`31a82887-f612-44ba-ba12-e21aee0f91fd`. It ran once on
`0af866e7bf0622e5d109df35ccbf04d9df9ff815`, was created at
2026-11-04T10:25:49.872Z and failed at evidence validation by
2026-11-04T10:26:54.198593Z with `EVIDENCE_SCOPE_MISMATCH`.
No production report, source read, retry, recovery or replay was invoked.

| Field | Requested | Retained submitted scope |
|---|---|---|
| Route / operation | Sale-window totals and top products | `get_product_sales_analysis`; resolved plan `period_comparison` |
| Subject | Sale totals and products by channel/currency | `platform_sales` |
| Product identity | Top 20 products | `entity_query=each channel and currency, with units sold and line sales` |
| Dates | 1–4 May 2026 inclusive | 4 May–4 November 2026; current day included |
| Grain | Event window / product | Month; included month 2026-05 |
| Source | Shopify only, Woo imports excluded | `shopify+woo`; explicit platform comparison |
| Channels | Online Store, POS combined, unknown separate | Online with channel breakdown, plus `exclude_pos` |
| Metrics | Gross incl. tax, refunds, after refunds; product units/line sales | `refunds` only |
| Event/campaign context | May Bank Holiday, KB hours if exact | No event scope or campaign request |

The verbatim retained prompt is `test/fixtures/bank-holiday-9e60ad05/request.txt`.
Its local pre-fix shared-context result reproduces these submitted values. This
is not evidence of a cache failure. The generic named-product matcher captures
“sales for each channel and currency…” as a product name. Independent platform
comparison matching treats “Shopify”, the excluded “WooCommerce” and “with units”
as a comparison and installs online-only platform filters. The later refunds
matcher overwrites the metric list; the compact day range is lost to generic
calendar parsing. The resulting route and subject contradict each other.

This was not the current published-product XLSX route (`product_report` was
null), and no generic campaign request was retained. Static production
composition and the local stub trace show that the selected general-product
producer declines `platform_sales`, so `baselineThenAgent` falls through to chat.
The original model's provider calls/response have not been retained in the
supplied projection and are not invented here.

**Remaining incident evidence:** the retained result contains no returned
context, plan or evidence, and no `scope_field`/`scope_differences`. The correlated
Render log lines were requested for the interval above. Without those lines,
the exact first field that caused the original mismatch cannot be established.
The wrong submitted fields above are proven; claiming that any particular one
was the first failing returned-evidence comparison would be speculation.

The patch preserves strict scope checks and adds bounded contract-field/type
metadata to retained mismatch failures and worker logs. It never stores raw
values, identities or credentials in these diagnostics. Subject, metric and
period mismatches now carry specific field paths. Sale-scope subfields are
included in the existing safe plan-difference traversal.

## Shared reporting fix

Explicit dated Shopify sale requests resolve through the same event-sale
capability, provider composition, knowledge retrieval and renderer as Black
Friday, before the independent generic product/platform recognizers. Existing
Black Friday policies and retained v1/v2 evidence keep their resolver semantics.
The new native-Shopify policy records the explicit dates, IANA timezone,
separate online/POS/unknown channels, import exclusion and per-currency top-N.
It does not hydrate a different subject or weaken evidence validation.

For the exact request, the interval is:

- London: 1 May 2026 00:00 through 5 May 2026 00:00, exclusive.
- UTC instants: `2026-04-30T23:00:00Z` ≤ time < `2026-05-04T23:00:00Z`.

Europe/London is on BST in May. Wall-clock conversion uses the IANA timezone;
nonexistent/repeated DST wall times are rejected instead of selecting an offset.

Recovered KB record `ev_b2c31f15-e83f-4651-bc53-4f1f1aa96581`, “May Bank Holiday
silver jewellery sale 2026”, is confirmed and recorded at
2026-09-30T11:25:49.492Z, source “User statement describing the May Bank Holiday
2026 sale”. It documents VIP access on 1 May, public access on 2 May, online and
in-store participation, and “midnight GMT on 4 May”. It gives no exact opening
hours, and that midnight wording does not establish an unambiguous channel
cutoff. The explicit inclusive London calendar dates therefore govern; no GMT
midnight interpretation or VIP/public duplicate counting is invented. The
report cites the original record and states this limitation.

If exact channel/store hours exist, they form a union of half-open sessions
within the requested dates. Daily opening hours remain separate daily sessions.
Store-specific POS sessions bind only verified native Shopify location IDs from
persisted Shopify order-location evidence. All qualifying participating POS
locations form one channel subtotal. Conflicting/missing clock or location
bindings leave that section unavailable and preserve the others. With the
actual general in-store record, all observed native POS locations in the
requested range are combined; campaign-discount participation is not proven.

Totals use the existing native Shopify definition: successful, non-cancelled
order original presentment totals including tax and recorded order discounts,
before refunds; successful refund events use their own refund timestamp.
Known Matrixify Woo imports are excluded from totals and lines. Deduplication
uses native order/refund/line IDs and latest observations. Ledger and collection
completeness remain unverified. Missing components are unavailable, never zero.

Online Store, recorded POS (retail location ID present), and unknown channels
stay separate, as do presentment currencies. Product rows are historical lines,
not a current-published-product population. They rank recorded discounted line
sales per channel/currency, with original units; shipping and order tax totals
do not reconcile to product lines. Product refund allocations and verified
campaign-discount use remain explicitly unavailable. Approved existing family
edges may group identities; no mappings are changed.

## Validation boundary

Regressions use the exact retained prompt, actual recovered KB record and
synthetic financial data. Interactive, durable and direct chat entrypoints run
with competing product/generic producers installed. Tests cover independent
component failures, exact/store/daily clock windows, top-N per currency, native
location filters, strict scope mutations, retained spreadsheet download and
reload. Generated financial/product SQL executes against fixture tables to
verify BST boundaries, duplicate observations, imported online/POS orders,
multiple POS locations, unknown channels, multiple currencies and refunds for
orders placed before the window. Existing Black Friday suites remain required.

The read-only operator-supplied job/KB evidence is actual production evidence.
Fixture financial outputs are not live sales totals. Google access here remains
blocked, and no Render log connector is available. No production writes,
collection, mapping changes or automatic report replay were performed. This
patch is not deployed.

## Local gate results

- `ORACLE_SQL_PYTHON=/tmp/bf-session-sql/bin/python npm run test:oracle:acceptance`:
  1,093 tests, 1,082 passed, 11 skipped, zero failures/cancellations;
  21 central conversations plus 89 provider/delivery suites. Native Shopify
  and existing Square boundary SQL fixtures executed with DuckDB/sqlglot.
- `ORACLE_BROWSER_DRIVER=/opt/codex/runtimes/cua/lib/node_modules/playwright-core/index.mjs npm run test:oracle:browser`:
  passed desktop/mobile and durable refresh checks, including the exact Bank
  Holiday composer case, spreadsheet download and existing Black Friday cases.

The gates validate local production composition with fixture providers. They
are not a replay of the retained request or verification of live sale amounts.
