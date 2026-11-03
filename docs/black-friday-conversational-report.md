# Conversational Black Friday sale reports

The verbatim failed request is retained in
`test/fixtures/black-friday-conversation/failed-request.txt`. Its reported response
showed January–December 2025 monthly sales and an unsolicited 2024 comparison.
The new single-year regression does not add that comparison. A separate explicit
2025-vs-2024 request and a relative-year follow-up test the two-year report.

## Reproduced cause

`before-route-trace.json` records a local run through the production chat router
on unchanged commit `5126c28`, using a fixture provider and an empty chat. This
reproduces the failure without cached evidence or any production report replay.

1. `/api/oracle/chat` calls shared scope resolution in `analysis-context.js`.
   `historicalEventRequest` previously required compare/report/overview-style
   wording. It missed “Can i have a break down…”.
2. The channel-sales recognizer selected `get_general_sales_analysis`, cleared
   event fields, and the natural period resolver interpreted “last years” as
   1 January–31 December 2025. Black Friday remained contextual text.
3. `createGeneralAnalyticsService` passed `comparison: previous_period` despite
   no requested comparison. The trace records this exact provider argument.
   The context request also treated the event mention as a promotion/exclusion
   request rather than the authority for the period.
4. Report v2 returned date-based finance evidence; general analytics collapsed it
   to monthly rows, and the shared sales renderer displayed both annual scopes.
   The failure is explained by parsing, routing and provider arguments. It is not
   attributed to caching.

## Corrected flow

Conversational event intent is recognized before generic calendar/channel logic.
A validated `event_scope` retains explicit/relative years, channels and product
requirements in the context and analytical plan. A singular “last years” selects
one sale year; “last year and the year before” selects two. Spreadsheet-only
follow-ups retain that exact context and use saved evidence without provider reads.
Non-sales subject switches, exclusions and quoted/editing requests are covered.

`createHistoricalEventDependencies`, shared by production chat, direct `/agent`
and durable jobs, dispatches scoped event requests to `event-sale-report.js`.
It retrieves confirmed/tagged knowledge entries through the existing knowledge
service. Online campaign phases use the existing reviewed relationship resolver;
physical-store entries remain independent. Different documented channel/store
windows are never replaced with one common November or annual window. Conflicting
confirmed windows block only their affected section and produce one focused
question. Missing/unconfirmed knowledge remains unavailable. Each resolved section
cites exact IDs, dates, content, source references, status and recorded timestamps.

Provider stages record knowledge resolution, capability selection, exact period
execution and answer completeness. Scope validation reconstructs windows from the
retained knowledge evidence, checks requested years/channels/metrics, and rejects
provider results with a different period. Deterministic rendering retains successful
sections when totals or product retrieval fails. Durable polling and retained XLSX
recovery use the same evidence contract.

## Metric and capability boundaries

* Totals use canonical finance gross sales less accounting refunds, including tax,
  in one currency. Refunds use their transaction date. Existing authority excludes
  Matrixify Shopify imports and legacy Shopify ledger representations, retaining
  legitimate Woo/native Shopify overlap. The optional recorded-channel projection
  preserves unknown Shopify channels instead of inferring online from a missing
  retail location. Default finance callers retain their prior channel projection.
* Exact ledger-day windows are supported where Europe/London days match the
  canonical UTC ledger day. Clock-time bounds cannot be recovered from daily ledger
  evidence; those sections remain unavailable. Store-specific finance attribution
  has no bound canonical provider here. Supporting store entries remain cited.
* Product rows use persisted source order lines, deduplicated by native order/line
  identity; native Shopify imports are excluded. Rankings are within source and
  currency. Source tax definitions differ, so line sales are explicitly operational
  and are not presented as a decomposition of canonical finance totals.
* Only active reviewed family/mapping edges link product identities. Unmapped IDs
  remain source-specific, including when mapping retrieval fails. Missing product
  IDs retain order/line identities rather than collapsing all unidentified items.
* Shopify/Woo WW/Woo US and completed Square line evidence have bindings. Woo JP
  product evidence and event-grain product refund units/amounts remain unavailable.
  Canonical total refund amounts and refund-event counts remain independently
  available. Square line channel attribution is not inferred from its platform;
  unlinked Square product rows are explicitly unknown channel.
* Coverage is unverified by the production providers. Observed currency/channel
  subtotals are labelled accordingly. Year-on-year changes require verified complete
  coverage and identical source, channel, metric and currency definitions; successful
  retrieval alone cannot establish comparability. No FX conversion is performed.

## Validation boundary

The exact failed request runs through fresh interactive/durable chat, with separate
cases for explicit 2025/2024 comparisons, relative years, product breakdowns,
knowledge ambiguity, independently failed totals/products/knowledge, malicious
annual-scope substitution, and authenticated XLSX download/recovery without replay.
The full browser gate also uses the real composer at desktop/mobile sizes.

Fixtures reuse existing repository event IDs for reviewed 2025 phases and the 2024
online event. In-store aggregate dates in the fixture are explicitly synthetic.
They do not assert live knowledge contents, figures or collection completeness.
No production report, source collection, mapping write or other production change
was executed. Deployed knowledge contents, source availability and numerical
reconciliation remain unverified; no automatic report replay is authorized.
