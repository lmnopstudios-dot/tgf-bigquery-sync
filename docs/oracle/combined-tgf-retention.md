# Combined TGF retention and Woo mapping review

Scope: entry 2022-10-19–2026-10-19, cutoff 2026-10-19, Europe/London; configured `email_candidate_v2`, snapshot `customer_identity/history-20261022-billing-v3`. No production data or governance decisions are changed.

The linked SQL already assigns `ROW_NUMBER` across Woo WW, Woo USD and Shopify using the frozen analytical customer reference. The next eligible order joins by that reference, without restricting its platform to the entry platform. Previously the report grouped those entries into separate source tables. The new explicit `linked_tgf` population aggregates membership after sequencing, with one collaboration/item/family/sitewide population. Calendar-age-qualified numerators and denominators are calculated from these members, never from platform percentages. Entry-platform counts and source-specific catalogue reconciliation remain expandable diagnostics. Unmatched/ambiguous local records remain separate; residual cross-platform double counting is possible. This is not a fully deduplicated population.

Combined reporting requires activated identity evidence. A failed readiness check does not silently produce a combined source-local sum. Existing source-separated retained evidence remains readable. Each component and supplemental section retains independent outcomes. Verified follow-up coverage is unchanged and remains a separate evidence requirement.

## Approved product routes and the consolidated review list

Classification reads already consume active approved identity and reporting-family routes. Product grouping previously consumed reporting families only. An approved Woo-to-Shopify parent identity now supplies the shared product key when no unambiguous reporting family exists, labelled `governed_product`, not a newly asserted family. Multiple family targets remain ambiguous; no titles are stripped or used to invent links. No mapping is approved again and no graph decision is written.

`diagnostics/retention-mapping-review.js` prepares one consolidated, customer-impact-ranked inventory of eligible historical Woo products lacking a supported route to a governed named collaboration, including ambiguous family routing. Historical order lines include archived products; there is no live/publication filter. It includes Woo ID/title, analytical customer and order impact, current approved routes, classification conflicts, and candidate Shopify parents with exact persisted SKU evidence and their governed collaboration names. Multiple candidate parents remain conflicts; unsupported targets remain null. A matching SKU is a proposal requiring review, not proof of product equivalence. Rows without a known collaboration must remain unattributed rather than being assigned by similar titles.

The first 500 products are retained with an explicit total/truncation indicator, ranked across WW and USD by affected customer records. Candidate arrays are bounded and marked as conflicting when multiple targets exist. Counts overlap across products and are not verified people. A missing route or missing historical product evidence never establishes “not sold on this platform.” This inventory does not certify source completeness.

**The production review list is not yet populated.** Google access here fails with OAuth 403 `Could not refresh access token: Domain forbidden`. Concrete Woo IDs, proposed targets and affected customer counts must come from the single bounded read below, not invented examples. Return its consolidated list for review; do not approve any new relationship automatically.

Use the existing Product Mapping/Product Families workflow (`/oracle/product-mappings`): find each Woo source ID, select the proposed Shopify parent, inspect choice preview, supporting/conflicting evidence and graph-safety diagnostics, then review the appropriate identity or reporting-family relationship. Missing SKU corroboration requires investigation, not a title-based relationship. Existing graph-safety checks and rejection/history rules remain mandatory.

After the user approves concrete decisions through that workflow, verify consumption with a read-only query against the same historical lines and current governed routes. Confirm the approved source ID reaches its intended parent/family and collaboration, ambiguity/conflict counts do not increase, and customer membership is deduplicated within that family. Then validate the combined calculations against the unchanged snapshot and scope. No order recollection or customer snapshot rebuild is necessary: product governance is resolved at calculation time. Approval and any new report execution remain separate actions; this diagnostic never performs either.

## Unresolved Shopify ranking component

Request `cf531490-b044-4ddd-b2fe-818a3ab91406` has a reported Shopify whole-range ranking rejection. Its actual rejection has **not** been retrieved here because of the same OAuth 403. Ranking validation is not relaxed or changed to guess the cause. The check inventories up to five exact-request execution rows deterministically, reads up to four independently, then reads only the existing Shopify ranking query's first result row and its bounded aggregate ranking array. It records the retained execution revision, original query ID, warehouse completion and per-row validation rejection. It never submits the original query or replays the report. A synthetic invalid-ranking fixture tests this reader; it is not evidence of the production failure's cause.

## Validation and merge status

Local fixture tests cover Woo-first/Shopify-return attribution, unmatched identical local IDs staying separate, combined denominators, strict combined identity/scope, approved product-route consumption, direct/interactive/durable delivery and refresh without rereading providers. The browser gate adds desktop/mobile combined presentation and refresh. Legacy source-separated fixtures explicitly retain their old scope to test recovered-report compatibility.

Generated SQL validation is separate: the local attempt to dry-run an actual combined linked SELECT was blocked by OAuth 403 before compilation. The pinned artifact includes all nine current source query shapes plus three combined shapes, with the actual linked-identity wrapper. Its combined synthetic case executes the generated ranking, first-entry and next-order CTEs with a Woo entry and Shopify in-store return. Synthetic execution cannot establish production coverage or snapshot readiness. Full SELECT dry runs establish compilation/planning only; no production population execution is claimed. Limited script dry runs are not used as proof of full scripts.

Previously supplied successful #376 checks remain historical evidence for that artifact; they are not asserted to validate this new SQL. A repeated planning timeout requires inspection of CTE/route/catalogue expansion and the materialized execution plan, not another timeout increase. Production budgets remain unchanged.

Keep this PR draft until the corrected SQL compiles in BigQuery, the retained Shopify rejection is explicit and addressed separately, and the concrete mapping inventory is available for review. Unknown follow-up coverage is a data-evidence limitation; SQL or validation failures are software issues and must stay visible.

## One bounded Render check

The command below uses deployed dependencies, one immutable reviewed artifact, aggregate read-only SQL and existing-job result reads. Its independent phases preserve results if another fails. It produces the single consolidated mapping review list, not a sequence of broad diagnostic commands. Full SELECT planning has a diagnostic-only allowance of 180 seconds per shape, two at a time; a timeout is reported as unresolved complexity. No collection, report replay, governance writes, deployment or configuration change occurs.

<!-- PINNED_COMMAND -->
