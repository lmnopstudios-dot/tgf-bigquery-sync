# Governed product mapping

Shopify Online and POS are transaction channels in one `shopify:shopify:<product_id>` namespace. Product evidence is consolidated at that key before title uniqueness, pairwise matching, or graph construction; channel remains available on report rows.

## Candidates and product search

`oracle/product-mapping.js` generates non-authoritative candidates across different source namespaces. It normalizes punctuation and `&`/`and`, compares shared title tokens, records SKU and Ready To Ship evidence, and orders the queue by sales, lines, then similarity. Priorities are review aids, not claims of identity. Deterministic matching is unchanged and fuzzy candidates never become canonical edges automatically.

The bounded picker searches title, normalized title, SKU, and source product ID across Woo WW, Woo USD, Shopify, and Square. It supports source filters, excludes the anchor product, returns at most 100 products, and contains product/aggregate importance only—never customer or order PII.

## Immutable decision architecture

Every event has a stable `decision_id` and `relationship_id`, reviewer, timestamp, provenance, and optional sanitized 500-character note. `supersedes_decision_id` closes an earlier decision; `replacement_for_decision_id` links a new edge to the approval it replaces. Rows are append-only. The shared resolver in `oracle/product-mapping.js` derives active approved and rejected relationships; its shared SQL CTE is used by Report v2 and production validators.

* **Approve** appends an active `explicit_governed_mapping` after graph validation.
* **Reject** suppresses the candidate but retains it in Mapping Decisions.
* **Choose correct product** validates first, then submits the original rejection and replacement approval in one batch after explicit confirmation.
* **Create mapping** approves a manually selected cross-namespace pair without requiring a candidate.
* **Change mapping** appends a supersession event and a linked replacement approval. The old approval remains visible.
* **Revoke mapping** appends a revocation that supersedes the approval; the edge leaves the current canonical graph.
* **Reconsider** appends a reconsideration (returning the pair to review) or an explicitly confirmed superseding approval.

Before any approval, the complete active graph is checked. A component cannot contain two products from the same source namespace. Validation completes before writes, so a detected conflict cannot partially persist a correction.

## Reporting and validation

Report v2 reads only active approvals resolved from immutable history. Rejected, revoked, superseded, reconsidered, and suggested relationships are not canonical edges. Source transactions are not rewritten.

After deployment run, in order:

1. `npm run validate:product-mapping-production`
2. `npm run validate:report-v2-production`

Both validators are read-only and emit aggregate, non-PII evidence. The focused validator checks schema, the shared resolver, bounded-search sources, history, graph constraints, and suppression. The Report v2 validator also reports decision-state/provenance totals and graph evidence.

## Canonical graph integrity

A source product is identified by `platform:store:product-id`; Shopify Online and POS therefore share `shopify:shopify`. Every direct edge must have two well-formed, different product refs from different governed namespaces. A complete connected component may contain at most one product from each of `woo:ww`, `woo:usd`, `shopify:shopify`, and `square:square`. Any business case needing two products from one namespace is a conflict requiring human review, not an exception.

The former Report v2 `graph_conflict_count` was not a component conflict count. Its SQL grouped all endpoints of all active approvals globally by namespace and counted namespaces occurring more than once. Thus the production value `3` meant **three repeated namespaces across the six approvals**, even when those approvals belonged to unrelated valid components. The dedicated validator only checked direct self/same-namespace edges, so both figures were answering different questions. Both validators now use the shared connected-component result.

Conflict diagnostics are bounded and contain component ref, duplicated namespace, source refs/titles, decision and relationship IDs, edge methods/provenance, reviewer and timestamps; they contain no customer or order data. Existing conflicts are never repaired automatically. In Mapping Decisions choose **Conflicts**, inspect the complete component and evidence, and only then use **Change mapping** or **Revoke mapping**. After the deliberate action, rerun both production validators and confirm their conflict counts and component IDs agree.

On first deployment run, in order:

1. `npm run validate:product-mapping-production`
2. `npm run validate:report-v2-production`
