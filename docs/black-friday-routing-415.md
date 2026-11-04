# Black Friday chat routing after #415

## Verified revision and reproduction

The operator's read-only Render check returned
`1ea765961522d9e45fffb5b8aa5544538af26c9f` for the checkout,
`RENDER_GIT_COMMIT`, local GET `/` and public GET `/`; both HTTP requests
returned 200. See `test/fixtures/black-friday-routing-415/render-revision.json`.
This verifies the running revision at that check, not the revision at the time
of the original requests (no request IDs were available).

Both verbatim prompts and both responses are retained in the adjacent fixture
files. Before changing code, both responses were reproduced through the actual
local authenticated chat entrypoint on that merge revision, with the production
baseline dispatcher, historical service and current-product service installed.
The captured `before-traces.json` records context, helper scope, operation,
fallback and zero financial/catalogue provider reads. No caching explanation
is necessary to reproduce either failure.

## Two shared parsing failures

The longer submission reaches shared context resolution but its reference to
"each session" hits the event guard's generic `sessions` exclusion. That drops
the event before campaign handling. `products sold` plus `campaign` then selects
product attribution; the absent governed campaign binding yields the supplied
limitation and whole-year dates. The old source recipe also associated the
first year mentions with later platforms, rather than reading the explicit
"For 2025" / "For 2024" clauses.

The shorter submission's event helper already resolves the correct scope. It
is bypassed by the outer context wrapper: the knowledge-save detector matches
`store` inside `in-store`, followed by `knowledge` in `knowledge base`. This
returns a knowledge-save request before the event transition runs. With no
resolved tool route, baseline fallback tries the current-product exporter; its
unsupported channel check produces the exact supplied response without reading
Shopify. Moving the event guard above generic campaign precedence cannot fix
this earlier wrapper bypass.

Knowledge saves now require a write command, preserving actual save/remember/
record/store/add instructions while excluding channel nouns and knowledge
reads. Sale sessions are distinct from visitor-session metrics. Source clauses
are associated with their own years. Unsupported explicit source/population
requests stay inside the historical answer, withholding affected financial
sections rather than silently executing a different source. Independently
supported sections remain. No dispatcher precedence was changed.

## Execution and validation boundary

Preflight exposes event scope, planned operation and capability registration
with zero provider attempts. Shared decision scope is `governed_event_knowledge`,
not an annual calendar. Existing stage callbacks trace knowledge resolution,
capability selection, each totals/product operation and answer completeness.

The new HTTP tests cover interactive and durable chat, both competing producers,
exact prompts, stale current-product clarification, partial knowledge/totals/
product failures, unsupported historical sources, midnight clarification,
authenticated workbook download and retained export without provider replay.
Composer browser cases exercise both exact submissions, endpoint follow-up,
download and reload on desktop/mobile widths. Existing session tests retain
VIP/public separation, store clocks, source authority, migrated-order exclusion,
refund SQL and currencies.

These are local regressions using recovered KB records and synthetic financial
fixtures. They do not validate live warehouse coverage, native store IDs or
production sales amounts. There was no production report replay, collection,
mapping change or production write. The Render health evidence does not imply
that this patch is deployed.

## Local check results

- `ORACLE_SQL_PYTHON=/tmp/bf-session-sql/bin/python npm run test:oracle:acceptance`:
  1,057 tests, 1,046 passed, 11 skipped, zero failures/cancellations;
  21 central conversations and 87 provider/delivery suites. The configured
  SQL interpreter executes the financial boundary SQL tests.
- `ORACLE_BROWSER_DRIVER=/opt/codex/runtimes/cua/lib/node_modules/playwright-core/index.mjs npm run test:oracle:browser`:
  passed desktop/mobile composer and retained recovery checks, including both
  exact routing submissions.
- An initial concurrent acceptance/browser run failed one unchanged
  customer-history publication `caller_deadline` test. Its isolated recheck
  passed all 15 tests; the full acceptance rerun above passed after browser
  completion. No unrelated deadline implementation or tests were changed.
