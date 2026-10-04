# Oracle Black Friday comparison runbook

## Demonstration

Use a new Oracle conversation on 5 October 2026 and submit:

> Can you please give me an overview of the last 3 Black Friday sales? I would like to compare sales, conversion rates and anything else you think may be of interest.

Oracle resolves the latest three **completed, confirmed Black Friday sale event records** as of the request date. The answer displays each reviewed sale start/end, duration, event ID, source type/reference and recorded time before figures. It does not substitute the nominal Black Friday–Cyber Monday weekend. Knowledge supplies scope only; governed finance, Metorik/Woo and native Shopify services supply figures.

Then submit this compatible follow-up:

> The last 3 years. Please emphasise daily sales, orders and conversion coverage.

The retained Black Friday event, online scope, requested metric families, separate-currency policy and count are used. An explicit change such as `Compare Search Console instead`, `Show customers instead`, or `What about shipping countries?` clears the incompatible historical-event route.

## Expected evidence and partial results

For every event, inspect the applied reviewed period and provenance first. Supported finance rows show eligible sale transactions, gross sales, recorded refunds, net gross, value per eligible sale transaction, duration and net gross/day separately by currency. Shopify-native conversion is shown only when that period has compatible behavioural evidence. Historical Woo periods state that conversion is unavailable rather than dividing Woo orders by Shopify/GA4 sessions. Products and customer classifications appear only when their source supports them.

One failed event/source is labelled with its bounded error code; other event sections remain visible. The structured `historical_event_comparison.v1` evidence envelope contains requested and resolved scopes, event provenance, source status, query start/completion times and collection time. It is returned independently of model synthesis and knowledge-proposal generation.

For a durable analysis, submit the same prompt using the UI's deep-analysis action, retain the returned job ID, and inspect `GET /api/oracle/jobs/<job-id>` after completion. The completed job's `answer` and `evidence` must match the interactive/direct deterministic route; proposal failure may set `proposal_error` but must not remove evidence.

## Read-only post-deployment checks

Run in the deployed service environment without printing credentials:

```bash
npm run diagnose:black-friday-scope
```

Confirm exactly three completed reviewed events, no 2026 event on 4 October 2026, no conflicts/invalid dates, and the expected source references. This command performs only a bounded aggregate knowledge `SELECT`; it does not write knowledge, retrieve inventory, run collections/backfills, alter schedules, or reset watermarks.

Exercise route parity with authenticated requests using secrets already present in the environment (never echo them):

1. `POST /agent` with the natural prompt and the configured bearer secret.
2. `POST /api/oracle/chat` with the same prompt in a signed UI session.
3. `POST /api/oracle/jobs`, poll `GET /api/oracle/jobs/<job-id>`, and compare `evidence.version`, `resolved_scope`, and event statuses.

Production credentials were not assumed during development. Live event records, source coverage, figures, and latency remain post-deployment acceptance checks; do not claim acceptance from unit fixtures.

## Demonstrated failure causes and boundaries

The prior flow classified the request as generic finance, asked for a date range, and interpreted “last 3 years” as a rolling calendar window rather than retained event scope. The model-selected multi-tool path also made rendering depend on final synthesis. Its fallback could therefore say no figures were available while still emitting a generic statement that figures were reproduced. The deterministic route now resolves reviewed events first and renders each successful source directly. Remaining production uncertainty includes provider availability, the contents/consistency of reviewed knowledge records, and actual historical source coverage.
