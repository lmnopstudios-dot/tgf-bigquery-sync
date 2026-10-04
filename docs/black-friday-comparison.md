# Oracle Black Friday comparison runbook

## Demonstration

Use a new Oracle conversation on 5 October 2026 and submit:

> Can you please give me an overview of the last 3 Black Friday sales? I would like to compare sales, conversion rates and anything else you think may be of interest.

Oracle resolves the latest three **completed, confirmed Black Friday campaigns** as of the request date. A campaign may contain multiple governed phases. The reviewed 2025 mapping retains VIP early access (`ev_2523cea3-5058-481e-9ac0-f6d4520603d6`, 27 November) and the public campaign (`ev_f9521f60-1aaf-41f6-a540-4e4bf00082dd`, 28–30 November) as distinct phases, and uses 27–30 November for a full-campaign total. Neither record supersedes the other. The answer displays every phase's ID, dates, confirmation and source provenance. It does not substitute the nominal Black Friday–Cyber Monday weekend.

Then submit this compatible follow-up:

> The last 3 years. Please emphasise daily sales, orders and conversion coverage.

The retained Black Friday event, online scope, requested metric families, separate-currency policy and count are used. An explicit change such as `Compare Search Console instead`, `Show customers instead`, or `What about shipping countries?` clears the incompatible historical-event route.

## Expected evidence and partial results

For every campaign, inspect the full period, phase periods and provenance first. The sales path uses only source-qualified Woo and native Shopify online orders, excludes Shopify POS, Square and Matrixify representations, and keeps currencies separate. It reports actual campaign totals, sales/order, sales/day and orders/day. The silver offer and exclusions are campaign context: they do not silently turn a whole-store comparison into a product-filtered comparison. Conversion appears only when compatible traffic evidence covers the exact campaign period.

Resolution diagnostics report five independent categories: genuine same-phase conflicts, missing expected years, unconfirmed records, unmatched phases/events, and invalid dates. Adjacent phases are never conflicts merely because their dates differ. The 2023 and 2024 periods must come from matching confirmed knowledge records; missing dates are not replaced with nominal weekends.

One failed event/source is labelled with its bounded error code; other event sections remain visible. The structured `historical_event_comparison.v2` evidence envelope contains requested and resolved scopes, phase provenance, source status, query start/completion times and collection time. It is returned independently of model synthesis and knowledge-proposal generation.

For a durable analysis, submit the same prompt using the UI's deep-analysis action, retain the returned job ID, and inspect `GET /api/oracle/jobs/<job-id>` after completion. The completed job's `answer` and `evidence` must match the interactive/direct deterministic route; proposal failure may set `proposal_error` but must not remove evidence.

## Read-only post-deployment checks

Run in the deployed service environment without printing credentials:

```bash
npm run diagnose:black-friday-scope
```

Confirm three completed reviewed campaigns; the exact two 2025 phase IDs and dates; a 27–30 November full period; no same-phase conflicts; and explicit `missing`, `unconfirmed`, `unmatched`, and `invalid` arrays. The command may exit 2 when history is incomplete—that is a diagnostic result, not permission to invent dates. It performs only a bounded aggregate knowledge `SELECT`; it does not write knowledge, retrieve inventory, run collections/backfills, alter schedules, or reset watermarks. It uses the shared credential helper, including `GOOGLE_PROJECT_ID` and `GOOGLE_SERVICE_ACCOUNT_JSON`.

Exercise route parity with authenticated requests using secrets already present in the environment (never echo them):

1. `POST /agent` with the natural prompt and the configured bearer secret.
2. `POST /api/oracle/chat` with the same prompt in a signed UI session.
3. `POST /api/oracle/jobs`, poll `GET /api/oracle/jobs/<job-id>`, and compare `evidence.version`, `resolved_scope`, and event statuses.

Exact local, read-only acceptance commands:

```bash
node --test test/historical-event-comparison.test.js test/black-friday-event-scope.test.js
npm run diagnose:black-friday-scope -- --as-of=2026-10-04
```

Production credentials were not assumed during development. Live event records, source coverage, figures, and latency remain post-deployment acceptance checks; do not claim acceptance from unit fixtures.

## Demonstrated failure causes and boundaries

The prior flow classified the request as generic finance, asked for a date range, and interpreted “last 3 years” as a rolling calendar window rather than retained event scope. The model-selected multi-tool path also made rendering depend on final synthesis. Its fallback could therefore say no figures were available while still emitting a generic statement that figures were reproduced. The deterministic route now resolves reviewed events first and renders each successful source directly. Remaining production uncertainty includes provider availability, the contents/consistency of reviewed knowledge records, and actual historical source coverage.
