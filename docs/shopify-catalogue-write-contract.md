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

All source timestamps are now represented as `BigQueryTimestamp` instances
before validation and binding. The product, collection, and membership source
projections select `catalogue_synced_at` directly from `UNNEST(@rows)`. Their
matched updates assign the required target column from that source field, and
their inserts use explicit column and value lists. For example, the membership
write boundary is:

```sql
USING (SELECT product_id,collection_id,catalogue_synced_at FROM UNNEST(@rows)) s
WHEN MATCHED THEN UPDATE SET catalogue_synced_at=s.catalogue_synced_at
WHEN NOT MATCHED THEN INSERT (product_id,collection_id,catalogue_synced_at)
VALUES (s.product_id,s.collection_id,s.catalogue_synced_at)
```

## Safe production diagnosis

The sync reads `shopify_catalogue.INFORMATION_SCHEMA.COLUMNS` after the
non-destructive `CREATE ... IF NOT EXISTS` statements and before any MERGE. It
compares names, BigQuery data types, and nullability with the intended contract
and stops on a difference; it never recreates a table.

Before each executed MERGE, structured diagnostics contain only the operation,
row count, shared sync timestamp, required field names and null counts, declared
struct field names, first-row keys, timestamp presence, and timestamp constructor.
Errors are prefixed with the exact operation name. No catalogue content or
credentials are logged.

The read-only production validator performs the same schema audit, inspects the
actual client serialization, and runs only `SELECT ... FROM UNNEST(@rows)` for
representative product, collection, and membership parameters.

Run on Render, in this order:

```sh
npm run validate:shopify-catalogue-write-contract-production
npm run sync:shopify-catalogue
npm run validate:catalogue-production
```

Run the third command only if the sync succeeds. Do not run product
classification sync as part of this sequence.
