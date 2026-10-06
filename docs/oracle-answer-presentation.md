# Oracle analytical answer presentation

Governed analytical delivery now leads with business figures and material limitations. Exact scope, definitions, provenance and diagnostics remain available in a collapsed **Show details** section. No evidence retrieval, calculations, collection, backfill or production state is changed.

## Architecture and recovery

1. Existing provider adapters retrieve structured evidence and calculate native metrics. General analytics preserves product resolution, scope, successful comparison periods and retrieval/coverage states. The merged relative-date clarification implementation remains authoritative.
2. `analysis-route-dispatcher.js` validates scope/evidence agreement and calls the existing chart selector. `answer-presentation.js` then renders supported evidence contracts into business prose and compact tables. It does not retrieve data, join populations, calculate rates or change metric values.
3. `answer`, `presentation.summary_markdown`, `presentation.supporting_markdown` and the full independent `evidence` are carried through interactive and durable responses. Existing job checkpoints persist that result. Refresh/reconnect reads it without replaying providers. Product export service recovery and manifest/artifact recovery use the same presenter, while the saved workbook/envelope remain unchanged.
4. Direct `/agent` governed dispatch uses that same presentation. Existing direct native conversion bindings also preserve their structured provider result. Model-assisted analytical routes receive shared presentation instructions; unfamiliar evidence contracts retain their original answer rather than hiding unrecognized limitations.
5. `public/oracle/answer.js` is the single display function used by immediate and recovered results. Markdown renders only supported semantic elements; untrusted HTML is text. Native `details`/`summary` provide keyboard controls and focus styling. Tables retain accessible horizontal scrolling. Real charts remain visible; their data tables and definitions are collapsed. A chart exception cannot remove the primary answer.

## Evidence semantics

- **No sales were recorded:** complete coverage and explicitly observed zero product sales, units and orders containing the product. Zero revenue alone is insufficient.
- **No sales records were found:** successful empty results do not imply zero. Include a short coverage limitation.
- **Sales could not be retrieved:** failed retrieval with no current sales figures. Successful comparison evidence remains available.
- **Partial evidence:** available figures remain visible; failed or incomplete evidence is disclosed.

Material limitations remain outside the accordion: unverified coverage, partial dates/failed periods, unverified cart attribution, unresolved shipping destinations, customer classification limits, incompatible conversion/source definitions, currency separation, provisional/incomplete exports and attributed revenue versus causal impact. Missing values remain unavailable. Existing safe diagnostic wording and requested/applied dates/cutoff remain in supporting evidence.

## Tested examples

The empty-product fixture runs through the real general-analytics adapter, shared dispatcher and direct governed-agent dispatcher.

Before:

> Product … channel online and in-store. The read succeeded but returned no matching current-period product rows. This does not establish zero sales or complete historical coverage. No Woo relationship was invented. The cross-sell activation date is unconfirmed; the requested window is a proxy. Recommendation attribution and causal uplift are unavailable.

After, primary content:

> No sales records were found. Coverage has not been verified, so this does not establish zero sales.
>
> Product: **18CT GOLD PLATED MICRO BONES HOOP (SINGLE)**.
>
> Purchases attributable to the cart cross-sell could not be verified. Its activation date is unconfirmed; these dates are a proxy.
>
> Dates: 30 September 2026–6 October 2026.
>
> Today’s data may still be incomplete.

**Show details** preserves the original supporting report, exact dates and runtime cutoff, coverage/retrieval status, selected identity/history and mapping metadata. It starts collapsed.

Other fixtures verify that:

- Country sales display `GBP 125.13`, while unresolved destinations are disclosed once.
- Campaign attributed revenue displays `GBP 120.57`; causal uplift is not asserted and recent attribution remains provisional.
- Conversion displays `3.12%` and unavailable periods, without treating different native definitions as a like-for-like comparison.
- Customer aggregates retain independent new/returning classifications without inventing overlap, retention or lifetime first-purchase semantics.
- Unranked export products remain **Unavailable**; the original downloadable workbook and full evidence survive recovery.

## Verification and live acceptance

Verified results: the full repository suite passed **920 tests**, with **3 skipped** and **0 failures**. The 16 presentation-contract tests also passed after the final supporting-metadata change. Desktop/mobile Chromium acceptance passed. An initial full run exposed two export recovery mismatches (fixed) and three inventory fixture failures caused by the injected production location ID; the clean run below passed.

Run the offline suite with `env -u SHOPIFY_INVENTORY_LOCATION_ID npm test`. The environment can inject a production location ID that conflicts with inventory test fixtures; no production inventory calls are required by these tests. Focused tests cover presentation, relative dates, conversation dispatch, automatic charts, exports and durable recovery. Calendar and Black Friday tests remain in the full repository suite.

For reproducible browser acceptance, install `playwright-core` outside the repository and run:

```sh
ORACLE_BROWSER_DRIVER=/absolute/path/to/playwright-core/index.mjs node diagnostics/oracle-presentation-browser.mjs
```

It uses installed Chromium and offline provider fixtures at desktop 1280×900 and mobile 390×844. Checks cover collapsed/expanded state, Enter/Space, safe markup, chart failure fallback, a real chart, focusable table scrolling, viewport containment and refresh. Screenshots go to `/tmp/oracle-presentation-browser` by default.

Remaining live acceptance after review and an independently authorized deployment: the production cart-cross-sell question; all named route families with real evidence; live model adherence to shared formatting instructions; authenticated durable reconnect/export recovery; and actual source coverage, mappings, timestamps and attribution windows. No deployment, merging or production mutation was performed for this change.
