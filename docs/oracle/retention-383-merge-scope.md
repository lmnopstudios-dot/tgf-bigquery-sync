# #383 release scope and merge recommendation

## Decision

Merge the narrowed #383 after the required acceptance and browser gates pass on
its final snapshot. This release fixes presentation and section-limit evidence;
it does not repair or create the missing Woo product relationships. Deployment
alone will not restore the historical Iron Maiden/Motörhead cohorts.

## Included runtime changes

- `public/oracle/app.js` and `mapping-presentation.js`: label actual product
  sources/references and distinguish heuristic title/SKU matching from persisted
  identity approval. Keep source payloads, actions, graph previews and approval
  safeguards unchanged. Reporting-family decisions remain a separate concept.
- `oracle/cohort-retention.js`, `retention-business-report.js` and
  `retention-limits.js`: attach component returned-row counts/quotas and provider
  truncation flags, and name affected sections without implying that item limits
  displace catalogue entries or collaboration totals. Do not alter provider
  arguments, row limits, SQL, eligibility, identity or rate calculations.
- The Woo review guide corrects USD T-shirt `108623`: no persisted no-equivalent
  outcome was demonstrated for that reference. The proven WW `80797` outcome
  remains WW-only; it must not be copied to USD.

## Deferred runtime resolver changes

Preserved at branch `defer/383-resolver-and-diagnostics`, commit
`7047d35ea37af293dccb6a3392a421815d5aefe5`, together with historical diagnostic
artifacts and investigation records. None is included in this release:

1. Classification family current-state selection: replace partitioning by
   membership ID with the shared per-source product-family resolver.
2. Legacy identity SQL relationship key: replace candidate-ID fallback with the
   UI-compatible sorted-endpoint SHA-256 relationship key.
3. In-process identity/family decision ordering: unwrap BigQuery TIMESTAMP
   objects before chronological sorting and decision-ID tie breaking.

`oracle/classification-reader.js` and `oracle/product-mapping.js` are restored
byte-for-byte to the current main baseline. Generated report artifacts,
materialized manifests and synthetic settings are also restored to that baseline.
These deferred defects have local regression support, but they were not shown
to restore these 24 products' actual saved approvals. Release them separately
with the necessary live BigQuery validation and explicit final scope.

## Preserved production findings and next action

The provenance read verified the UI destination `gf-full-data.commerce`, END.
WW `114959` as a consumed approved-family control, and retained-result parsing.
No persisted identity/family approval was found at the 24 inspected Woo parent
references or inspected variations. Related Square relationships remain Square.
Recorded submitted/saved operations preserve their source keys; no conversion
was demonstrated. Missing Woo relationships require concrete human review,
not relabelling Square decisions or automatic approval of title leads.

Use the review guide to verify appropriate Woo WW/USD relationships through the
existing graph-safe workflow. Keep old/new Warpig designs distinct and resolve
the Ace of Spades target discrepancy before a decision. After approved decisions
are persisted, verify report consumption and request a new report. No collection,
republication, snapshot repair, IAM work or production data change is part of
this PR preparation. Historical source coverage certification remains separate.

## Final narrowed-tree validation

- Required acceptance gate: 821 passed, zero failed/cancelled/skipped, 21 central
  conversations and 59 provider/delivery suites. The count is lower than the
  earlier 854 because deferred diagnostic/resolver suites are not release scope;
  baseline suites remain and three focused presentation/bounds checks are added.
- Required browser gate: all 21 conversations at desktop/mobile viewports pass,
  including durable refresh, activated identity refresh and zero-write picker
  namespace/heuristic assertions.
- All 12 generated linked report SELECT shapes (WW, USD, Shopify and combined;
  collaboration, item and baseline) compare byte-for-byte equal to main
  `c22df6162b9e1abdd29c8e628cdaab045496961b`.
- No live BigQuery execution or production mutation was performed. None is
  claimed as verification of the deferred resolver changes. There are no runtime
  resolver changes left in the narrowed #383.

**Recommendation: merge the narrowed #383 after normal review/CI.** It is a
presentation/evidence-disclosure release, not a declaration that the combined
historical report is ready or the missing Woo relationships have been saved.
