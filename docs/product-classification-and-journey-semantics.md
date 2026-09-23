# Governed product classification and acquisition journeys

## Catalogue evidence and population

`sync:product-classifications` first inspects `INFORMATION_SCHEMA.COLUMNS` in the persisted Shopify, Woo WW, Woo USD, and Square datasets. It reports and reads only actually present catalogue tables/fields from the bounded allow-list: product type, tags, collections, categories, attributes, vendor, and item/catalogue metadata. A missing field is not assumed and a product with no usable evidence remains unknown.

The v1 dimensions are `product_group`, `collaboration_name`, and `product_category`. Category values are accepted only when a catalogue field itself exactly normalizes to one of ring, pendant, necklace, bracelet, chain, earrings, clothing, accessory, gift voucher, or other. Titles are never inputs. Catalogue values `collaboration`/`collab` establish collaboration membership; the structured form `Collaboration: <persisted value>` additionally establishes its governed name. `core` is an explicit negative group; absence is unknown, not core.

Human-approved active records take precedence over authoritative catalogue records, which take precedence over canonical propagation. Propagation accepts only active deterministic or explicit governed mappings. Suggested, rejected, revoked, and conflicted edges are ignored. Origin reference and evidence are retained. Contradictory active values at a subject/type become `conflict`, remain diagnosable, and are excluded from journey SQL, without disabling unrelated classifications.

The sync creates the table if absent and deterministically MERGEs stable IDs. Its aggregate result includes inserted, updated, unchanged, conflicts, and skipped unknown. It does not alter source catalogue data. Human records use the same append/supersession-ready contract (`reviewed_by`, effective dates, and `supersedes_classification_id`); a management UI is intentionally deferred.

## First-order semantics

Acquisition journeys default to `first_observed_ever`: qualifying orders are loaded through `observation_end`, sequenced across all available governed history, and only then filtered by `cohort_entry_start` / `cohort_entry_end`. `first_observed_in_period` is an explicit alternative that applies the lower entry bound before sequencing. Cancellation, status, migration, refund, and identity qualification are unchanged.

“Ever” means available governed history for a source-qualified identity. It is not proof of a customer's first-ever TGF transaction. No Woo-to-Shopify identity is asserted, and anonymous historical Square activity remains unavailable. Source coverage floors are therefore the earliest persisted qualifying source dates; the production validator reports the material period-relative difference rather than inventing earlier history.

## Production validation

The read-only validator audits persisted metadata fields, per-source product and line/sales classification coverage, collaboration-known coverage, names/categories, provenance, conflicts and unknowns. It also reports customers whose global first order predates the entry period, cases where in-period semantics would differ, and the eligible acquisition cohort. Collaboration acceptance remains fail-closed until active collaboration records exist.
