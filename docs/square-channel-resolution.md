# Square payment-channel field shape

The completed coverage run is preserved: 49,840 eligible Square transactions,
19,853 customer-history orders, 17,039 analytical records, all channels Unknown.
These are retained pre-fix results; this change does not overwrite or recalculate
them. The saved warehouse schema contains `card_details_entry_method`, whereas
the old channel SQL read only `card_details.entry_method`. Old local fixtures
supplied a nested STRUCT and did not cover the persisted flattened representation.

## Shared resolver

`oracle/square-channels.js` supplies both production reporting and the diagnostic.
It supports the flattened field, nested object and JSON-encoded card-details
object. Blank codes are missing; payment codes are uppercased/trimmed. Nonblank
native order/location IDs retain their exact values for joins.

Both representations may be present only if their normalized values agree.
Contradictory values remain Unknown even if both codes individually indicate
card-present payment. Malformed JSON is missing evidence, not proof of a channel.

In-store requires at least one completed payment, known exact matching order and
payment locations, and **every completed payment** to be CARD with EMV, SWIPED or
CONTACTLESS entry evidence. Pending, approved, failed and cancelled payments do
not establish physical purchase or override completed-payment location evidence.
This corrects the previous location predicate, which counted contradictions from
non-completed payments. Cash, other/mixed completed tenders, missing joins/types/
entry methods, keyed/on-file/unsupported methods and contradictory completed
locations remain Unknown. Multiple consistent completed card-present tenders are
allowed. No Unknown order is silently reclassified as online.

The single primary reason partitions orders. Individual missing/conflict flags
can overlap. Payment counters count persisted rows, not deduplicated payment IDs;
this patch does not invent revision timestamps or a new payment lifecycle model.

## One narrow Render validation

Use the final handoff's pinned temporary checkout command; no merge or deployment
is required. In that checkout, the bounded entrypoint is:

```sh
timeout --signal=TERM --kill-after=3s 120s node diagnostics/square-channel-validation.js
```

It reads only existing `square_data.orders` and `square_data.payments`, reuses the
accepted latest-order selection and COMPLETE/COMPLETED eligibility, and keeps the
original cutoff **19 October 2026, Europe/London**. It performs one free full-SELECT
dry run, then at most one executed aggregate query with a **1,000,000,000-byte
ceiling**, 45-second query timeout and 90-second runner deadline. The shell adds a
120-second outer limit. An unavailable or oversized estimate stops execution.
Uncertain failures remain unavailable; no retry/replay is performed.

Output includes channel/primary-reason order counts, completed/card-present and
ignored non-completed payment rows, missing/conflicting evidence flags, and
whitelisted flat/nested method, status and tender-shape counts. It emits no
customer, order, payment or location identifiers. All JSON events are saved
incrementally in a private `/tmp/square-channel-validation-*.jsonl` file. The
allocated job ID is printed for later metadata inspection.

This is payment-channel validation, not a collaboration, retention or second-
purchase report. It performs no customer collection, mapping approval, identity
snapshot replacement, extension review/activation or persistent business write.
A successful run validates the evidence-supported subset; it does not prove that
all Square transactions happened in-store or certify complete follow-up coverage.

## Tests and release boundary

The generated resolver SQL is exercised against 24 local payment cases covering
flattened/nested/encoded data, agreement and conflict, cash/mixed tenders,
pending/failed payments, exact-key mismatches, missing locations/types/methods,
malformed JSON, keyed entry and consistent split-card payments. Full generated
customer-report fixtures produce identical cohorts for all three field shapes.
The diagnostic tests cover its two input tables, aggregate/privacy/reconciliation
checks, dry-run ceiling and one bounded execution. Tests use DuckDB/SQLGlot to
translate generated SQL locally; this is not native BigQuery verification.

Required gates remain `npm run test:oracle:acceptance` and
`npm run test:oracle:browser`. The browser gate cannot launch in this workspace
because Chromium is unavailable. Native validation and deployed report behavior
remain pending; keep draft until required release checks pass. Review activation
separately, retaining existing opt-in controls and provisional-rate limitations.
