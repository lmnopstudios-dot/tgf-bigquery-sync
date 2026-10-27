# Collaboration-entry next-order investigation

Request: `38f9aa99-3566-43e0-a0e0-19577a62532c`.

The supplied incident describes a request for next-order products after a
first-observed purchase containing a named collaboration item. Oracle selected
collaboration retention; `tgf/retention_windows` and
`tgf/retention_piece_windows` were rejected at `population_query`.
These are user-reported observations, not independently retrieved evidence.

The production attempt from this environment failed before dataset metadata:
`EPERM` connecting through the configured proxy to the Google OAuth endpoint.
With execution network access enabled, the targeted diagnostic confirmed
HTTP 403 `Could not refresh access token: Domain forbidden`. The enforced
network policy does not allow the Google authentication/warehouse endpoints.
Neither retained execution revisions nor analysis/warehouse job IDs were read.
The underlying failures are unknown. A population-query rejection does not
establish a timeout, SQL syntax error, correlation error or resource limit.
No production SQL, deadline, classification, identity mapping or report changed.

## One targeted production read

From this checkout in the existing authorized production runtime:

```sh
node diagnostics/oracle-collaboration-entry-errors.js
```

This reads only the request's saved job records and metadata for warehouse job
IDs referenced in their retained outcomes. It reports execution revisions,
analysis job IDs and attempts, routed context, both component outcomes and
warehouse error reasons/messages/locations. It preserves distinct executions
rather than selecting the latest or equating deployment with execution.
Independent metadata failures retain the successful metadata. It excludes
answers, customer records, credentials and saved SQL. Output bounds and
truncation are explicit. It never calls Oracle, replays a report, collects data,
updates a queue or changes mappings. Run it once and retain the returned JSON.

## Routing lead and pending implementation

`oracle/analysis-context.js` tests product journeys before retention, but requires
popularity/top/ranking language. When retention intent matches, product routing
also requires overall/first-purchase-product language. The product definition in
`oracle/product-journeys.js` explicitly requests an unrestricted entry
classification, whereas retention requests collaboration classification. Thus
neither existing contract represents the requested combination simply by
substituting the other report. The exact original message and saved context
have not been retrieved, so this is a static routing lead only.

After reading the retained errors, implement a separate shared contract for one
deduplicated named-collaboration-entry population, next eligible order products
across the full range, named-collaboration breakdowns and first-purchase
collaboration-item breakdowns. Preserve linkage before first-observed selection,
governed classification and product-family attribution, imported-order
exclusions, unknown attribution denominators, continuous coverage safeguards,
and successful independent sections. Keep accepted collaboration retention and
whole-range second-purchase contracts unchanged. Routing, provider calculation,
strict contract validation, direct/interactive/durable/browser recovery and
cross-subject follow-ups need end-to-end regression coverage before release.
This diagnostic patch does not implement or verify that analysis.
