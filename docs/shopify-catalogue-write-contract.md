# Shopify catalogue BigQuery write contract

## Failure analysis

The JavaScript validation added in `d2bbe3d` (the change referred to as `1163095`
in the incident report) checked the pre-serialization object only. The explicit
`TIMESTAMP` type does not make an ISO string a timestamp in
`@google-cloud/bigquery`: for a nested `ARRAY<STRUCT<...>>`, version 8.1.1 reads
the `.value` property expected on `BigQueryTimestamp`. An ordinary string has no
such property, so the client generated a struct field with an undefined value.
BigQuery consequently received SQL `NULL`, even though the JavaScript row passed
the non-null validation. The earlier regression test called the converter but
only asserted that it did not throw; it never inspected the converted parameter.

The later production validator proved that `BigQueryTimestamp` also does not
survive the actual nested binding boundary. Catalogue timestamps are therefore
ISO-8601 strings in every nested `ARRAY<STRUCT>` parameter. The shared product,
collection, and membership source projections convert those strings to target
timestamps in BigQuery. Nullable Shopify timestamps use `SAFE_CAST`, while the
required sync timestamp uses `TIMESTAMP(...)`. For example, the membership write
boundary is:

```sql
USING (SELECT product_id,collection_id,
       TIMESTAMP(catalogue_synced_at) AS catalogue_synced_at
       FROM UNNEST(@rows)) s
WHEN MATCHED THEN UPDATE SET catalogue_synced_at=s.catalogue_synced_at
WHEN NOT MATCHED THEN INSERT (product_id,collection_id,catalogue_synced_at)
VALUES (s.product_id,s.collection_id,s.catalogue_synced_at)
```

The next production run passed the schema audit (`differences: []`) and all
timestamp checks, then failed only `products catalogue binding validation
failed: empty_tags_survive`. The complete observed path was a normalized
JavaScript `tags: []`, an `@rows` runtime empty array, and an explicit nested
`['STRING']` type. BigQuery client 8.1.1 serialized that field as an
`arrayValues: []` parameter value, but `UNNEST(@rows)` returned the nested field
as SQL `NULL`, not as an empty array. Thus the value was neither absent from the
client struct nor malformed JSON: the empty nested array changed to `NULL` at
the server binding boundary.

Products no longer bind a nested array. After the normalized `string[]` passes
pre-write validation, the transport layer serializes it with `JSON.stringify`
to a `tags_json STRING` field. Both the production MERGE and read-only validator
use the same source projection to reconstruct the governed value:

```sql
COALESCE(JSON_VALUE_ARRAY(tags_json), ARRAY<STRING>[]) AS tags
```

This preserves ordered string elements—including commas, quotes, apostrophes,
Unicode, and ampersands—without delimiter parsing. `COALESCE` also guarantees
the projection cannot supply SQL `NULL`; normalized empty tags serialize as
`'[]'` and reconstruct as an empty `ARRAY<STRING>`.

## Safe production diagnosis

The sync reads `shopify_catalogue.INFORMATION_SCHEMA.COLUMNS` after the
non-destructive `CREATE ... IF NOT EXISTS` statements and before any MERGE. It
compares names, BigQuery data types, and nullability with the intended contract
and stops on a difference; it never recreates a table.

The governed product contract defines `tags` as `ARRAY<STRING> NOT NULL`, which
matches the production table. A tagged product has an array of tag strings and a
product without tags has `[]`; `NULL` is never a normalized catalogue value.
Absent or explicit-null Shopify tag values normalize to `[]`, while pre-write
validation rejects a missing, null, non-array, or non-string normalized value.
Only after validation does transport serialization replace `tags` with the
explicitly typed `tags_json: 'STRING'` parameter field.

The target table schemas remain unchanged: all persisted timestamp columns are
`TIMESTAMP`, and `catalogue_synced_at` remains `NOT NULL`.

Before each executed MERGE, structured diagnostics contain only the operation,
row count, shared sync timestamp, required field names and null counts, declared
struct field names, first-row keys, timestamp presence, runtime type, and the
distinct `STRING` parameter / `TIMESTAMP` target types.
Errors are prefixed with the exact operation name. No catalogue content or
credentials are logged.

The read-only production validator performs the same schema audit, inspects the
actual client serialization, and runs only SELECT queries for representative
product, collection, and membership parameters. These queries use the same
exported source-projection builder as each production MERGE and assert raw string
binding, converted type/non-nullability, nullable timestamp behavior, and both
empty and populated product tags. Empty tags are checked with both `tags IS NOT
NULL` and `ARRAY_LENGTH(tags) = 0`; populated punctuation and Unicode tags are
checked for cardinality and ordered values.

Run on Render, in this order:

```sh
npm run validate:shopify-catalogue-write-contract-production
npm run sync:shopify-catalogue
npm run validate:catalogue-production
```

Run the third command only if the sync succeeds. Do not run product
classification sync as part of this sequence.
