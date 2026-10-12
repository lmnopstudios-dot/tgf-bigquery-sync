# Governed promotion interpretation acceptance

Base: merged main `d5899df`, containing PR #304. The shared native daily-sales
provider, plans, conversation isolation, durable delivery and owned exports are
retained. No knowledge record is rewritten; the supplied production record ID
appears only in an acceptance fixture.

## Demonstrated failure and limits of the diagnosis

The production prompt creates a weekday daily-sales plan with an exclusion
request. The previous resolver queried confirmed business context using topic
tags, then required a confirmed, provenance-bearing **structured** date range
before any narrative interpretation. `searchKnowledge` aliases event
`description` to `content`; the old resolver's textual matcher read
`description`, not `content`. For this particular title, the requested words
already occur in the title, so that shape mismatch alone does **not** explain
its rejection. A record with this narrative and null/unknown structured dates
is retrieved by the governed query's open-ended null-date overlap predicate,
then rejected by structured-date eligibility. There was no prose interpretation
step. Separately, the old online-only predicate rejected any retail-tagged
event, even when its narrative explicitly established online availability.

Tests reproduce this chain through the actual knowledge service SQL and
production-shaped `content` rows. They cover both narrative-only and structured
fields; they do not assert that the supplied live record has null dates or any
particular tags. A bounded SELECT-only lookup of the supplied record returned
HTTP 403 in this environment. Consequently the live structured fields, tags,
actual retrieval logs and which rejection happened in that production request
remain unverified. No live sales, inventory or collection calls were made.

## Retrieval, interpretation and scope

Promotion intent retains ordinary requested event words and normalizes sale /
promotion / offer / discount references. Confirmed event-only governed searches
use bounded text terms and overlapping analytical periods, without mandatory
topic tags. Exact relevance, confirmation, provenance and positive online
applicability are validated after retrieval. Full-limit results cannot establish
complete promotion evidence. Different matching public ranges conflict; separate
explicit VIP/early-access phase records may legitimately have distinct ranges.

The read-only interpreter records its version, record ID, source type/reference,
original date fields and narrative, extracted VIP/public evidence, offer
restrictions, applicability and date basis. It recognizes explicit full-year
named or ISO dates with start/end evidence and precise structured day/range
fields. It does not infer a missing year, timezone or unsupported wording.
Unsupported temporal evidence remains unresolved and asks for dates. Ambiguous
midnight wording always requires endpoint clarification, even if structured
calendar dates also exist. Conflicting narrative endpoints are surfaced.

The supplied narrative establishes VIP access on **1 May 2026** and public
access on **2 May 2026**. No default midnight choice is applied:

| Clarified meaning | Exclusive endpoint | Whole affected London days |
|---|---|---|
| Start of 4 May, GMT | 2026-05-04T00:00:00Z (01:00 BST) | 1–4 May |
| End of 4 May, GMT | 2026-05-05T00:00:00Z (01:00 BST) | 1–5 May |
| End of 4 May, BST (separate test evidence) | 2026-05-04T23:00:00Z | 1–4 May |

The targeted reply changes only the promotion endpoint, retaining the analytical
window and successful unadjusted figures. Final exclusions cover **whole days
of overall online sales**, including partially affected days. They do not
measure discounted silver-item sales or causal promotional uplift. Both totals
and included-day denominators are recomputed. Tables show adjusted days, totals
and averages; charts, XLSX and recovered evidence use the same validated
exclusion dates. Recovery replays original retrieved knowledge and rejects
changed interpretation, source, scope, chart or calculation. Existing PR304
structured artifacts remain readable under their original plan shape.

The same interpreter applies to shared ecommerce contextual reports. Ordinary
aggregate sales requests retrieve their named promotion and explicitly disclose
that aggregate-period evidence cannot recompute daily exclusions; the supported
adjusted route is the daily weekday analysis. Monthly/product attribution and
causal uplift are not invented. Unknown online applicability is not assumed.

## Coverage

Observed daily-row dates, eligible averaging days and verified population
completeness are separate. For 284 observed expected dates with unverified
population completeness, the answer says all expected dates are represented and
the rankings remain provisional. It does not imply missing dates. Explicit zero
days still require the existing complete-population proof for averaging.

## Acceptance and remaining live checks

The dedicated promotion tests cover the exact prompt, actual governed result
shape and SQL, narrative/structured dates, VIP/public phases, GMT/BST boundaries,
ambiguous endpoints, invalid dates, unrelated/unconfirmed/retail-only/non-overlap
and conflicting records, failed knowledge retrieval with sales retained,
adjusted totals/counts/averages, XLSX/chart/recovery agreement and tamper rejection,
284/284 wording, shared aggregate/context routes and legacy artifacts.

Existing shared-plan HTTP tests now use narrative-only mixed online/retail
promotion evidence: interactive and durable delivery both clarify midnight,
export/download/retry, refresh/poll recovery and owned manifest validation.
The desktop/mobile browser diagnostic uses the real composer and durable
worker, answers the targeted clarification, checks the common chart scale,
keyboard details controls, semantic scrollable table, XLSX and artifact-only
refresh without another provider call. These are offline fixtures, not live
production validation.

After access is restored, use the bounded promotion diagnostic to inspect
returned metadata and interpretation, and a separately bounded existing
native daily-sales read to compare observed coverage. Check an owned production
export/job through existing read-only recovery validation. The actual midnight
meaning still requires confirmation by someone with source knowledge. No source
mutation, backfill, collection, inventory call, schedule change, deployment or
merge is part of this work.
