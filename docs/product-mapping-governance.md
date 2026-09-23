# Governed product mapping

Shopify Online and POS are transaction channels in one `shopify:shopify:<product_id>` namespace. Product evidence is consolidated at that key before title uniqueness, pairwise matching, or graph construction; channel remains available on report rows.

## Review candidates

`oracle/product-mapping.js` generates non-authoritative candidates across different source namespaces. It normalizes punctuation and `&`/`and`, compares shared title tokens, records SKU and Ready To Ship evidence, and orders the queue by sales, line items, then similarity. High/medium/low are review priorities—not probabilities or claims of identity. Multiple candidates for a product remain visible.

Deterministically recognizable shipping, service, gift-voucher, and unidentified custom lines are classified and excluded. Ready To Ship titles are **not** stripped for automatic canonical matching; they can only be suggested.

## Decisions and reporting

Oracle's Product Mapping screen writes append-only review events to `commerce.product_mapping_decisions`, including reviewer, timestamp, evidence, provenance, and optional note. Rejected pairs are suppressed from future suggestions. Approval first rejects same-source canonical-component conflicts, then creates an `explicit_governed_mapping` edge. Latest decision reads are deterministic and history remains preserved.

Report v2 reads only latest approved edges. Precedence is: approved explicit mapping, exact unique SKU, exact unique normalized base title, then source-specific unresolved. Suggested candidates never enter that query and never alter totals. Oracle describes suggestions as possible improvements, never definite identity.

## Production workflow

1. Run `npm run validate:report-v2-production` first and retain its aggregate, non-PII output.
2. Confirm Shopify duplicate source identities after consolidation is zero and compare each before/after coverage row.
3. Open **Oracle → Product Mapping**, optionally search, and review the highest sales/line-item impact candidates first.
4. Inspect evidence and competing-candidate warning; approve only a known equivalent, otherwise reject it.
5. Re-run the validator, then inspect Report v2 Products. Only approved edges should change canonical aggregation.
