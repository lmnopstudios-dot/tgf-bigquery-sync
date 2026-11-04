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

## Follow-up: recovered source evidence and exact sessions

The user recovered the live knowledge rows with a read-only Render SELECT on
3 November 2026. The unmodified rows are retained in
`test/fixtures/black-friday-conversation/live-knowledge.json`; numerical provider
fixtures remain synthetic. Both 2025 entries explicitly say the promotion was
**online-only** and **physical stores did not participate**:

| Knowledge ID | Title | Documented dates | Hours |
|---|---|---|---|
| ev_f9521f60-1aaf-41f6-a540-4e4bf00082dd | Black Friday 2025 public campaign | 28–30 November 2025 | Not recorded |
| ev_2523cea3-5058-481e-9ac0-f6d4520603d6 | Black Friday 2025 VIP early access | 27 November 2025 | Not recorded |

The #414 physical detector matched “Physical stores did not participate” as
positive applicability. It excluded both rows from online resolution, then grouped
them into one unspecified-store bucket and called the distinct dates conflicting.
The new session resolver classifies applicability before store/session grouping.
It keeps the public and VIP online sessions separate. It does not invent a 2025
Square campaign period from either online record. Confirmed nonparticipation is
reported as such, without asking the user to choose between those records.

The recovered 2024 rows establish:

* Soho (`ev_35c7f84c-75aa-44df-9878-e1e76676f898`): 7 November, 12:00 PM–8:00 PM.
* TGF East (`ev_4f0a2bbe-6f60-4c09-bf4c-1dfb8f421309`): 9 November, 10:30 AM–6:30 PM.
* Online (`ev_d62be9ed-527e-403a-a661-cb2d11095ca5`): from 8 November at 8:00 AM GMT,
  “through 10 November 2024 at midnight GMT.” The source alone does not distinguish
  start/end of that day. The user explicitly confirmed **end of 10 November**.
  The request-scoped exclusive endpoint is **11 November 2024 00:00 GMT**; the
  stored knowledge text is unchanged.

All exact windows use half-open timestamps. Distinct stores, explicitly distinct
sessions, and non-overlapping sessions remain independent. Only contradictory
windows for the same store/session generate a conflict question. Identical
records merge their citations without duplicating a provider calculation.

### Source authority and timestamp providers

The request-scoped `bf-2024-2025-v1` source policy applies to totals and products:
2025 online is native Shopify Online Store, 2024 online is WooCommerce, and
in-store is Square. Shopify Matrixify imports are excluded. The policy survives
scope validation, provider execution, durable persistence and XLSX refinements.

The timestamp adapter binds existing Square payments/refunds by native IDs,
completion status and verified location. It reuses the existing card-present
channel rule; cash/mixed/unknown tender is not silently classified as POS. Amounts
are deduplicated at payment/refund identity before aggregation. Products require
all successful payments of the native order to lie inside the session; boundary
split payments are not allocated to a whole order without evidence. Refunds use
their own event timestamp rather than the original order's timestamp.

Woo WW/USD adapters use persisted order creation timestamps and `refunds_api`
refund timestamps, joining currency through exact native order IDs. Shopify uses
persisted financial/refund timestamps, successful sale/capture/refund evidence,
and the Online Store predicate. Product queries use the same source selection and
instant bounds. Reviewed family/identity reads do not modify mappings.

Gross observations survive an independently missing refund source; net remains
unavailable when refund evidence is missing. Unknown money/currency is never zero.
Native timestamped source totals are explicitly distinguished from reconciled
canonical ledger totals. Calendar-date observations for the 2025 entries are
labelled as date-grain evidence with **hours unrecorded**, not exact sale-hour
results. Source-native line tax definitions remain separate. Neither temporal
membership nor a 20% discount proves campaign-discount attribution.

Location lookup requires one persisted native Square location ID, an exact
normalized store name (only the cosmetic TGF prefix is removed), and a compatible
recorded timezone. East is not guessed to mean Shoreditch. Missing or duplicate
bindings fail that store independently. Dataset locations come from metadata;
knowledge's EU job location is not applied to warehouse datasets.

### Remaining verification boundary

Initial Render warehouse reads used an incorrectly fixed EU job location and
returned `notFound`. They do **not** establish absent data. The user has been given
a region-aware metadata/location extraction; its output is pending. Therefore
native deployed Square location IDs, warehouse schemas, per-window row coverage
and actual financial figures remain unverified. No sales report, collection,
source/mapping write or production replay has been executed for this follow-up.

The new `event_sale_report.v2` contract retains session bounds and source authority.
A frozen v1 resolver validates already-retained #414 evidence without provider
calls. Local regressions use recovered knowledge plus synthetic financial rows;
generated Square SQL is also transpiled/executed locally against timestamp,
store, successful-payment and refund boundary fixtures. This verifies calculations
and SQL semantics, not deployed warehouse availability or completeness.
