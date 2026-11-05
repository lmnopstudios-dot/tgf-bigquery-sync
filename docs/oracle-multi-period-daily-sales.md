# Independent daily sale periods

The exact requested fix is retained in
test/fixtures/multi-period-daily-sales/request.txt. Its report asks for independent
populations, not one annual Black Friday selection.

| Section | Source and channels | Half-open UTC bounds |
| --- | --- | --- |
| Black Friday 2024 | Woo WW/USD online, no POS | 2024-11-08T08:00:00Z through 2024-11-11T00:00:00Z |
| Black Friday 2025 | Native Shopify Online Store | 2025-11-27T00:00:00Z through 2025-12-01T00:00:00Z |
| May Bank Holiday 2026 | Native Shopify Online Store, POS and unknown separately | 2026-04-30T23:00:00Z through 2026-05-04T23:00:00Z |

## Evidence and trace

The supplied sediment attachment was not visible to the file reader. Search did
not recover that transcript. No retained production job, returned evidence,
request ID, provider trace or period amounts were available. The observed
response described by the user is not presented as a reproduced production run.
No production reads, writes or automatic report replay were performed.

before-scope.json records a local reproduction on unchanged main 6b3318f, using
the exact fix request and its embedded report request. The full fix request
fails INVALID_ANALYSIS_CONTEXT because repeated year mentions exceed the old
five-entry limit before deduplication. The embedded report request resolves
event_name Black Friday, years 2024/2025/2026, global channels online/instore,
null grain, empty dimensions and no source policy. The old scope has nowhere to
retain explicit per-period bounds, channel exclusions or source choices.

The old planner projects that shared event scope as named_event_comparison.
resolveSaleSessions then searches Black Friday knowledge for each year/channel;
it cannot represent May separately. With no source policy, event-sale-provider
chooses canonical finance period totals, whose mixed-source rows can include Woo
refunds. The renderer filters channel but not source and has no daily table.
These are demonstrated source-level mechanisms, not a claim about which live
operations ran in the unavailable incident.

## Implementation

Explicit numbered daily-sale requests retain a validated list of periods in the
existing event scope. The planner retains day grain, day/channel dimensions and
the full period list, including source, channels, instants and VIP date.
resolveSaleSessions expands only each period's own channels. Explicit requested
dates govern; knowledge hours from a different campaign cannot replace them.

The existing event timestamp provider supplies both daily and independent period
aggregates through the same SQL function. The only SQL difference is the
DATE(transaction_timestamp, 'Europe/London') select/group expression. Eligible
order/source/channel/currency predicates and half-open bounds are identical.
Sales group on order-created time; refunds group on refund-created time even
when their original order predates the window. Native Shopify excludes known
Matrixify imports for both. No Woo refund query can run in a Shopify section.
No Square or product-line provider is selected by this request.

Each period retains daily evidence, period evidence and component reconciliation
by source/channel/currency/transaction type. Discrepancies include signed
differences; they disclose independent-read/snapshot uncertainty instead of
inventing a cause. Failed/absent refund evidence stays unavailable, including
net values that depend on it. Missing dates are not filled with zero. Successful
sources/operations/sections survive independent failures. Stored canonical totals
or different date/source definitions are not substituted for these timestamp
measures. Live numerical reconciliation with the unavailable incident remains
unverified.

The deterministic renderer produces three named period sections, nested channel
sections, London daily tables, VIP/public labels for November 2025, component
reconciliation and period subtotals. Blank lines before tables are necessary for
the existing browser Markdown renderer. Independent successes remain visible
after durable recovery without more provider reads.

Scope validation checks the complete period list, resolved windows, source
component membership, channel/amount/transaction roles, daily grain/timezone,
row dates, duplicate groups and recomputed reconciliation. Existing event
evidence versions and strict plan validation remain in use.

## Validation

The persistent acceptance matrix includes oracle-multi-period-daily.test.js.
The exact request runs through real authenticated interactive and durable chat.
Fixtures prohibit unrelated sources, verify query predicates/bounds, preserve
USD/GBP, exercise independent refund/daily/period failures, discrepancies and
tampering, and check provider-free recovery. Both desktop and mobile composer
tests assert visible daily tables and labels after reload.

Generated BigQuery SQL is transpiled with sqlglot and executed on synthetic
DuckDB tables to test the 2024 08:00 start/exclusive end, May BST grouping and
bounds, Matrixify exclusion, Online Store/POS/unknown separation and refunds
whose order predates the period. This does not establish live BigQuery source
availability or coverage. The SQL fixtures run with TZ=UTC because their
TIMESTAMP columns represent BigQuery UTC timestamps.

Release checks and their outcomes are recorded in the PR. No deployment,
production writes, collection, knowledge changes, merging or report replay is
included.
