# Shared clarification consumption after PR305

Base: merged main `6a3bb9d` containing PR305. The shared analytical plans,
governed promotion retrieval, narrative interpretation, native online daily
sales contract, interval validation and owner-scoped delivery remain intact.
The supplied event ID occurs only in a production-shaped acceptance fixture.

## Demonstrated cause

Before this change, a context with `promotion_context.pending_endpoint=true`,
`pending_dates=true` and `pending_endpoint_date=2026-05-04` received:

> Include 4 May as a sale day. Exclude 1–4 May inclusive from the comparison.

The daily-sales handler recognized a continuation but neither its ISO-only
supplied-period matcher nor its start/end-of-day matcher recognized that reply.
The reproduced transition had **no changed fields**, empty supplied periods,
unchanged YTD dates and an unresolved promotion. It executed the unchanged plan;
re-reading the same narrative therefore produced another unresolved interval
and unavailable adjusted averages. No validated exclusion was being overwritten
by the source: no exclusion instruction had been consumed in the first place.
Nor was a stale result needed to explain that reproduced response.

The context remained an analytical sales context, rather than becoming a
`knowledge_save` request. Independently, proposal preflight treated the
include/exclude sentences as assertions and attempted knowledge proposals.
That independent classification explains the proposed record containing the
instruction. Tests spy on actual interactive and durable proposal calls: the
analytical sequence now makes none, while explicit knowledge saves still invoke
proposal generation. Ordinary factual assertions retain their existing proposal
behavior; the guard does not suppress all messages in an analytical chat.

A separate delivery audit found that non-export interactive results had no
refresh recovery, and that completed job/export pointers could outlive the
result they represented. The fix adds authenticated recovery of the latest
validated result and retires obsolete pointers. Recovery uses existing evidence
validation against the current context, not client-supplied financial data.

## Consumption and execution

The shared transition consumes a compatible reply against active pending fields
before unrelated-request and knowledge-save routing. Explicit new analyses and
explicit save/remember commands retain their own routes. Product selection,
campaign-relative dates and product filter/metric replies share clarification
recognition and proposal suppression; their existing governed execution remains
in place. Delivery/ranking modifiers in a clarification reply are also applied.

Inclusive ISO or named date ranges are validated. An omitted year comes from
the pending event's date, with the analytical year used only if no pending event
date exists. The reply creates `supplied_periods` plus a request-scoped
`calendar_instruction`, clears the pending flags and retains the original YTD
window, shop, online channel, currency, grouping and native metric definitions.
The same instruction can be retried without changing the analytical dates.

The promotion resolver separates **user-selected comparison days** from source
historical interpretation. The confirmed source record, ID, narrative,
provenance, VIP/public phases and offer exclusions are retained. Its historical
midnight interpretation can remain unresolved; it is no longer an actionable
question for this calendar-day comparison. Re-reading it cannot change the
selected comparison interval. If source records conflict, the conflict is
retained and disclosed while the explicit calendar-day comparison is applied
independently. Existing source-only conflict handling is unchanged.

Explicit GMT/UTC/BST choices are recorded as request-scoped timezone
interpretations and retain the stored timezone wording. They do not rewrite
knowledge. An incomplete timezone-only reply still requires an endpoint choice.

For 1–4 May 2026 inclusive, the applied dates are exactly:

| Date | Weekday excluded |
|---|---|
| 1 May | Friday |
| 2 May | Saturday |
| 3 May | Sunday |
| 4 May | Monday |

Tuesday–Thursday are unchanged. Totals and eligible-day denominators are
recomputed from the same validated daily population. Compatible prior daily
evidence is retained across clarification, ranking and output refinements;
population, metrics, dates, source/currency or timezone changes prevent reuse.
A failed new knowledge read can retain the previously validated source provenance.
The answer leads with the adjusted ranking, while keeping original figures.
Chart labels distinguish selected sale days from source-confirmed intervals.
Tables, charts, XLSX, retry and recovered evidence use the same exclusions.
No adjusted production amounts are asserted by these offline fixtures.

## Delivery and recovery

The existing session-owned evidence cache stores resolved context and artifact
metadata alongside validated evidence. `/analysis/latest` is authenticated and
returns only evidence agreeing with the current context and within the existing
15-minute cache lifetime. It regenerates governed presentation/charts. It neither
collects source data nor trusts a client-provided result.

The browser resumes pending jobs first; otherwise it recovers the latest
validated result before falling back to owned jobs/exports. Successful
interactive delivery clears obsolete completed-job pointers. Completed
analytical jobs remain recoverable even without an export. A new question clears
recovery pointers, and responses from an older scope do not change current
recovery state. Persistent owned job/export recovery remains available; the
in-memory latest-result cache is not a promise of recovery after server restart.

## Acceptance and live boundary

The dedicated tests execute the exact production sequence through real shared
interactive and durable HTTP, native Shopify daily provider wiring and governed
knowledge result shape. They assert actual applied dates, one removed eligible
day for each affected weekday, unchanged original figures and raw population,
recomputed totals and averages, zero analytical knowledge proposals, adjusted
headline, metric refinements, owned XLSX/chart/manifest agreement, old-job polling,
latest-result refresh, retry and source provenance. A fixture rejects additional
sales reads during refinement, proving retention of successful original evidence.

Both HTTP paths also exercise product selection, campaign send-date clarification,
product metric/filter selection, timezone choice and explicit knowledge save.
Unit acceptance covers ISO/named/abbreviated inclusive dates, invalid dates,
re-reading different source dates, disclosed conflicts and combined output/metric
instructions. Existing UI factual-proposal regressions remain covered.

Desktop/mobile browser acceptance uses the real composer and durable worker:
initial question, interactive inclusive reply, refresh **before export**, adjusted
chart, owned XLSX download, artifact-only fallback recovery, keyboard details,
semantic table/viewport scrolling and clearing an obsolete job pointer. Existing
presentation browser acceptance is run separately.

No live production sequence was executed, and no production adjusted amounts
were retrieved. Remaining live checks are the deployed conversation's resolved
context, applied exclusions, owned persisted job/export validation and a browser
refresh against the deployed service once this PR is reviewed and deployed by
the normal release process. Source access was previously unavailable with HTTP
403; no collection, backfill, inventory read, source/knowledge mutation, schedule
change, deployment or merge is part of this task.
