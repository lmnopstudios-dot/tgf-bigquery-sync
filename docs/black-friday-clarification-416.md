# Black Friday endpoint clarification and native Square locations

## Clarification failure after #416

The exact user reply is retained in
`test/fixtures/black-friday-clarification-416/reply.txt`. The preceding prompt is
the supplied online/in-store 2025/2024 comparison from #416; the real chat
entrypoint emits the pending question for online KB record
`ev_d62be9ed-527e-403a-a661-cb2d11095ca5`. Both turns run through interactive
and durable authenticated HTTP, with composer browser coverage.

On merge revision `2f82b52`, local HTTP reproduction shows that the reply is
**not** an explicit knowledge-save intent. Instead, it is not consumed as an
event clarification. Ordinary scope parsing reduces the comparison to 2024
online. `suppressAnalyticalProposals` misses the opening “End of day”, while
`needsProposalGeneration` accepts its assertive sentences and invokes the
proposal generator. That is the path capable of opening Save/Edit/Discard.
The retained pre-fix trace uses a proposal-generator spy, not a production model
or a production replay. Both recovered native Square names also fail the old
resolver in that trace.

The shared clarification consumer now recognises the endpoint answer, preserves
the existing report population and applies the end-of-day choice. The KB start
remains 8 November 2024 08:00 GMT; the exclusive end becomes 11 November 2024
00:00 GMT. The original KB record is unchanged. Mixed start/end answers are
rejected rather than silently selecting one. Explicit save instructions still
prepare proposals for review; report clarifications do not.

Validated prior event evidence can be reused only for the same report population,
metrics, source policy and timezone. The service re-resolves the retained KB
entries, fetches the newly available 2024 Woo totals/products and retains every
unchanged section verbatim, including store blockers. It does not repeat other
provider calls or refresh KB observations. Repeating the same endpoint answer
reuses all sections. If the prior evidence has expired, unaffected sections are
marked `EVENT_RETAINED_SECTION_UNAVAILABLE` instead of replaying them.

## Actual persisted Square evidence

Read-only Render reads supplied by the operator establish `gf-full-data` /
`square_data` is in **US**. Prior EU metadata queries were not evidence that
these tables were absent. Both `locations` (10 rows, including four inactive
locations) and `retail_locations` (7 rows) are present. The schema listing found
no separate location history/snapshot table.

| Requested store | Persisted native name | Native Square ID | Created |
|---|---|---|---|
| Soho | The Great Frog Soho | AZM5427E1CX5W | 2016-09-16T12:14:18Z |
| TGF East | The Great Frog East | 0PK6CB3STX295 | 2018-12-06T12:22:43Z |

Both records have Europe/London timezone and occur in both metadata sources.
The old resolver removed `TGF` but not `The Great Frog`, so neither matched.
The fix expands only the brand spelling; East remains distinct from Shoreditch.
It inspects raw persisted rows as well as the semantic view (which chooses one
row per ID), does not filter inactive locations, deduplicates repeated rows by
native ID, rejects multiple IDs/timezone conflicts and rejects locations created
after the session. No permanent aliases, hard-coded production IDs or mapping
writes were added. Renamed-row behavior is tested synthetically; no actual
East-to-Shoreditch rename is claimed.

Historical corroboration, without monetary or product reads:

| Store | 2024 persisted order rows | First / last order timestamps | Payment evidence |
|---|---:|---|---|
| Soho | 6,641 | 2024-01-02T10:50:42.000Z / 2024-12-31T15:43:17.000Z | 7,521 rows; 2024-01-02T10:50:43.126Z through 2024-12-31T15:43:17.348Z |
| TGF East | 2,659 | 2024-01-02T12:35:22.000Z / 2024-12-31T15:42:31.000Z | No row returned for this native ID in the bounded 2024 payment-presence read |

Exact evidence and limitations are retained in `square-evidence.json`. The first
whole-row JSON order read exceeded its 100 MB cap; a three-column read succeeded
under the same cap. These are persisted-row counts, not deduplicated sales,
payment coverage certificates, or event report results. East's absence from
payment evidence is a separate blocker: the current governed binding uses
successful payments for totals and paid-order line attribution. No order-value
substitute or zero is inferred.

The production query tests verify independent native location parameters and
half-open GMT filters for Soho on 7 November 2024 12:00–20:00 and East on
9 November 2024 10:30–18:30. They retain WooCommerce 2024 and Shopify 2025
VIP/public sections and leave missing sources unavailable. Refund and product
mapping definitions, imported-order exclusion and separate currencies are
unchanged. Financial amounts in tests are synthetic.

No source collection, production report execution, mapping change or production
write was performed. Google OAuth from this workspace remains blocked with
“Domain forbidden”; the actual metadata/presence evidence came from the
operator's read-only Render commands. This patch does not deploy or replay the
report, and does not claim live sale-window totals have been validated.

## Local validation

- Required acceptance gate: 1,076 tests, 1,065 passed, 11 skipped, zero failures
  or cancellations; 21 central conversations plus 88 provider/delivery suites.
  Run with `ORACLE_SQL_PYTHON=/tmp/bf-session-sql/bin/python` to execute the
  financial boundary SQL fixtures as well.
- Required browser gate: passed desktop/mobile, durable refresh and the exact
  clarification composer case. Driver:
  `/opt/codex/runtimes/cua/lib/node_modules/playwright-core/index.mjs`.
- An initial acceptance run failed the unchanged customer-history publication
  `caller_deadline` timing test. Its isolated recheck passed all 15 tests and the
  full gate rerun above passed. No customer-history deadline code/tests changed.
