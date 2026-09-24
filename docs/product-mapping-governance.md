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

Before any approval, the complete active graph is checked. A component cannot contain two products from the same source namespace. Validation compares the graph immediately before and after the proposed edge: it rejects every newly introduced same-namespace product pair, while a pre-existing conflict in an unrelated component no longer blocks a safe write. Existing conflicts remain reported and unresolved; they are not suppressed, repaired, or treated as valid. Validation completes before writes, so a detected new conflict cannot partially persist a correction.

For candidate `0e0bcd00a8eda894832d7dc6`, run this first from the deployed repository root in a Render Shell:

```sh
npm run diagnose:product-mapping-candidate -- 0e0bcd00a8eda894832d7dc6
```

To reproduce the separate **Choose correct product** failure without writing, run:

```sh
npm run diagnose:product-mapping-candidate -- '3f4ceb34b70f26d84ed4f605=gid://shopify/Product/10434349072711'
```

This candidate-specific command is read-only: it loads transaction-derived products and immutable mapping history with `SELECT` queries, reconstructs deterministic and governed edges, and does not call schema setup or any review/write method. An optional `candidate_id=selected_product_id` argument reproduces the replacement edge constructed by **Choose correct product**. Its JSON shows both proposed endpoints and their current components, followed by each newly conflicting same-namespace product pair and the complete shortest evidence path between it. Every path edge identifies its source (`deterministic_identity`, `governed_approval`, or `proposed_candidate`), mapping method, endpoint refs, and decision/relationship IDs when present. It also contrasts the former governed-edge-only validator graph with the full write-time graph. A title mismatch is evidence only and is never used to bypass graph safety.

The smallest safe correction is to revoke or change the single erroneous active governed approval identified on the conflict path. If the path instead identifies a deterministic edge, correct the underlying duplicate SKU/title identity evidence; do not approve the candidate or weaken the one-product-per-namespace invariant. When the output cannot isolate an erroneous edge, leave the candidate unapproved and report the shown path as ambiguous.

The incremental check is also required by the historical product grain. Woo Ready To Ship products were separate source products by size or stock item, whereas Shopify represents them as variants beneath one product parent. Approving a second Woo product into a Shopify identity component that already contains another Woo product still creates a new same-namespace pair and is rejected.

### Governed Shopify-parent reporting families

`commerce.product_family_decisions` is a separate append-only decision log. Each membership has a stable decision and membership ID, source and Shopify-parent refs/titles, reviewer, timestamp, provenance, note, and supersession/replacement links. One source product can have only one active Shopify parent; a reviewer must explicitly **Change family** before choosing another parent. Multiple products from the same Woo store may be active members of the same parent. **Revoke family** appends a revocation. No family row is ever passed to `approvedMappingEdges`, deterministic identity, or graph safety.

In **Choose correct product**, the reviewer now has two deliberately different confirmations. **Confirm identity mapping** retains the existing graph-safety path. **Assign to Shopify reporting family** is enabled only when the selected result is a Shopify parent and states that source identity is preserved. A graph rejection never automatically becomes a family assignment.

Report v2 resolves an active family membership to `family:shopify:shopify:<parent-id>` before choosing the display grouping. It also assigns the Shopify parent's own lines to that reporting ref. The query remains at stable source-product/channel/currency grain and retains source product ID, child variant IDs, options embodied by source lines, units, sales, and line count. A unique active membership is joined once to each input line, so memberships regroup rather than duplicate transactions. Unresolved products retain their `source:` rows. Finance, currency, refunds, and the identity graph are unchanged.

On rollout, application startup invokes the additive schema setup and creates `commerce.product_family_decisions`; no backfill or automatic title-based assignment occurs. Existing identity decisions need no migration. A reviewer then assigns `woo:ww:135969` and `woo:ww:62682` independently to the Shopify **Micro Michael Rodent Pendant** parent.

The exact first Render Shell command is read-only and previews both the current identity conflict and the non-identity family resolution (including whether the family table exists):

```sh
npm run diagnose:product-mapping-candidate -- 82a4a562756f935c97ba559e
```

After deployment: open **Product Mapping**, find the candidate, choose **Choose correct product**, search Shopify for **Micro Michael Rodent Pendant**, select the parent, and verify that **Confirm identity mapping** and **Assign to Shopify reporting family** are visibly distinct. Choose the family action and confirm its warning. Open **Reporting Families** and verify the active row, source ref `woo:ww:135969`, parent ref/title, reviewer, time, provenance, and note. Repeat for `woo:ww:62682`; both rows must remain active. Check Report v2 Products for one family reporting ref with separate source-product rows and unchanged totals. Finally exercise **Change family** and **Revoke family** on a non-production test membership (or inspect their controls without confirming in production), and rerun both read-only validators.

## Reporting and validation

Report v2 reads only active approvals resolved from immutable history. Rejected, revoked, superseded, reconsidered, and suggested relationships are not canonical edges. Source transactions are not rewritten.

After deployment run, in order:

1. `npm run validate:product-mapping-production`
2. `npm run validate:report-v2-production`

Both validators are read-only and emit aggregate, non-PII evidence. The focused validator now reconstructs products, deterministic edges, and governed edges exactly as write-time graph safety does; the former governed-edge-only check could pass while an approval failed. It also checks schema, the shared resolver, bounded-search sources, history, graph constraints, and suppression. The Report v2 validator also reports decision-state/provenance totals and graph evidence.

## Canonical graph integrity

A source product is identified by `platform:store:product-id`; Shopify Online and POS therefore share `shopify:shopify`. Every direct edge must have two well-formed, different product refs from different governed namespaces. A complete connected component may contain at most one product from each of `woo:ww`, `woo:usd`, `shopify:shopify`, and `square:square`. Any business case needing two products from one namespace is a conflict requiring human review, not an exception.

The former Report v2 `graph_conflict_count` was not a component conflict count. Its SQL grouped all endpoints of all active approvals globally by namespace and counted namespaces occurring more than once. Thus the production value `3` meant **three repeated namespaces across the six approvals**, even when those approvals belonged to unrelated valid components. The dedicated validator only checked direct self/same-namespace edges, so both figures were answering different questions. Both validators now use the shared connected-component result.

Conflict diagnostics are bounded and contain component ref, duplicated namespace, source refs/titles, decision and relationship IDs, edge methods/provenance, reviewer and timestamps; they contain no customer or order data. Existing conflicts are never repaired automatically. In Mapping Decisions choose **Conflicts**, inspect the complete component and evidence, and only then use **Change mapping** or **Revoke mapping**. After the deliberate action, rerun both production validators and confirm their conflict counts and component IDs agree.

After the candidate preview and UI acceptance, run in order:

1. `npm run validate:product-mapping-production`
2. `npm run validate:report-v2-production`
