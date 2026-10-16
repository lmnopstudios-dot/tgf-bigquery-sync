# Basket BigQuery query rejection

Base: latest main `2f92e566b3cb3219c63a0b7988fd8319e21205f5`, verified
through GitHub and git fetch; includes merged #326 and
`6a37e1de4aff37c6da09d43c24027cd9a46ce5e2`. Operation transitions are unchanged.

## Demonstrated defect

The actual `basketPopulationSql('gf-full-data')` has this code-owned expression
at line 29. Column 57 starts the alias, not the CAST or a parameter:

```sql
        CAST(original_unit_price_presentment AS STRING) original_unit_price_presentment,
                                                        ^
```

This excerpt was inspected: it contains only source identifiers and syntax,
no private literals. BigQuery's typeless STRUCT field grammar requires `AS`
before an explicit field alias. The four calculated money fields inside
`ARRAY_AGG(STRUCT(...))` omitted it. Fix all four aliases; retain the existing
NUMERIC-to-STRING output serialization. No field substitution or new cast.
An independent SQLGlot BigQuery parser rejects the original at line 29
(`Expecting )`) and parses the corrected full query. This is local grammar
evidence, not server-side SQL/schema validation.

The prior diagnostic completed metadata/schema work before its population dry
run. Its outer catch always used `schema_inspection`; the interactive boundary
used `basket_population`. Neither label proved the failed substage. The new
diagnostic records each completed stage and returns the actual failed stage;
the provider wraps dataset, schema and basket reads at their owning boundaries.
Independent coverage failures still retain populated basket evidence. The shared
order-value diagnostic also stops dependent dry runs and reads after failed or
incompatible schema inspection; completed independent checks remain in its report.

## Shared contracts inspected

`orderValuePopulationSql` supplies the same locations/financials/status/geography
snapshot reduction, eligibility predicates and joins to basket, histogram,
coverage and trace consumers. Those population builders and predicates are
unchanged. Line snapshots remain unique on order/line identity. Basket math,
quantity/discount reconciliation, exclusions, unknowns, ownership, persistence
and exports are unchanged. No aggregate substitute or intent inference.

`orderValueQueryOptions` supplies the actual SDK types and values:

| Parameter | Type | Value source |
|---|---|---|
| start_date | STRING | validated 2026-01-01 |
| end_date | STRING | validated 2026-10-15 |
| country | STRING | GB |
| currency | STRING | GBP |
| basis | STRING | observed_subtotal |
| assumed_charge | NUMERIC | 8 |
| matrixify_app_id | STRING | shared governed MATRIXIFY_APP_ID constant |

Dates remain `DATE(@start_date)`/`DATE(@end_date)`. The real SDK serialization
is tested. Dataset metadata determines the actual location; no fallback region
is introduced. Production client still uses explicit project and configured
credentials. Legacy SQL stays disabled; byte/time/row bounds remain enforced.
Collector-declared line schema in server.js matches the checked-in metadata
fixture (including extra unused columns). This does **not** establish the actual
deployed schema; both probes inspect INFORMATION_SCHEMA before dry runs.

Shared safe errors now retain fixed categories (syntax, missing schema field,
missing parameter, type mismatch, dataset location mismatch) and statement
positions, never messages, unexpected tokens or row/credential literals.
Schema mismatch types are allowlisted. Presentation retains one explanation
and next step with technical metadata in one Show details section; definitions
already rendered as prose are omitted from the metadata table.

## Read-only Render verification without deployment

From the existing Render service's repository root, download the standalone
probe from this PR's **full commit SHA**, inspect it, then run it. It loads the
existing production dependency factory and real builders from the current
working directory, even when saved under /tmp. It imports no server/collector.

```sh
curl --fail --silent --show-error \
  https://raw.githubusercontent.com/lmnopstudios-dot/tgf-bigquery-sync/COMMIT_SHA/diagnostics/oracle-basket-sql.mjs \
  --output /tmp/oracle-basket-sql.mjs
node /tmp/oracle-basket-sql.mjs \
  --start 2026-01-01 --end 2026-10-15 --preview-struct-alias-fix
```

The probe reads dataset metadata and at most 250 schema rows, then dry-runs the
deployed basket query, corrected basket query, shared coverage and order-value
histogram. At most five SQL jobs, 1 GB per query, 15 seconds per operation,
60 seconds overall; no population rows or query/parameter dumps. It prints only
required schema identifiers and allowlisted types, stage/category/location,
parameter types and a fixed inspected source expression. The preview replaces
only the four exact missing-AS expressions in memory. Original rejection and
preview success are separate checks; exit status remains nonzero if the
original query fails. If the corrected query also fails, its safe stage/category
and schema comparison identify the next fact to investigate. No deployment,
collection, source mutation or scheduling is needed.

On this branch's checkout, omit `--preview-struct-alias-fix` to validate the
corrected production SQL directly. For subsequent complete read-only calculation
acceptance from an approved checkout containing the fix:

```sh
node diagnostics/oracle-basket-composition.js \
  --start 2026-01-01 --end 2026-10-15 --execute-read-only
```

## Validation and remaining acceptance

Live attempt in this task stopped at dataset metadata with HTTP 403. No deployed
schema was retrieved, and **no actual BigQuery dry run or population execution
succeeded**. The provider's unrestricted exception body was not printed. A
further schema/type/permission issue remains possible; no such issue is claimed
as verified. Run the standalone Render probe above to resolve that uncertainty.

Focused production-factory tests cover aliases, SDK types, stage failures,
sanitized errors, schema blocking, unchanged basket reconciliation and both
interactive/durable delivery, exports and recovery. The persistent acceptance
matrix now includes the SQL-boundary suite. Browser acceptance covers desktop,
mobile and refresh. See PR validation results for completed counts.

After SQL validation, remaining live acceptance is the exact supplied basket
question, full-period and May 1–4 exclusions, thresholds 200/225/250, honest
reconciliation/unknown counts and coverage, interactive/durable retrieval,
owned export and refresh recovery. Do not infer customer intent or complete
collection coverage. Deployment and merging are outside this task.
