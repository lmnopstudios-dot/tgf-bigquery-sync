# Finance failure diagnostics without collector recovery

This change is independent of the collaboration report PR #370 and based directly
on main. Historical finance failure attribution is **closed: cause unresolved**.
It is not a prerequisite for report review, completeness verification or merging
#370. No existing structured exception/warehouse error is accessible here; six
supplied exact failure records have empty error strings.

## Reproduced defect and fix

The installed BigQuery SDK constructs PartialFailureError with nested row error
objects. Its top-level message can be empty even when a nested reason/message
exists. Persisting only String(error.message), and printing only e.message, loses
that information. This is locally reproducible; it does not prove the historical
failure's class, reason, column or stage.

The new pure formatter produces a versioned, bounded JSON envelope in the existing
finance_refresh_runs.error STRING and CLI stderr. It includes:

- The first known phase: fetch, transform, promotion setup, staging creation,
  staging insertion, or promotion; canonical table, run UUID and batch index
  where known. An outer catch does not overwrite the inner failed phase.
- Allowlisted exception name, HTTP status, warehouse job ID when actually present,
  nested-error entry count, safe reason codes, fixed categories and matching
  canonical column names. Unknown failures remain explicitly unclassified.
- Truncation indicators for bounded sampling. At most 20 outer error entries and
  five inner entries per outer error are inspected. Arrays are capped at four
  reasons/categories/fields; tested envelope size stays under the prior 1,000-char
  storage budget without slicing JSON into an invalid record.

No raw message, SQL, row data, credentials, response body or arbitrary unknown
field/value is serialized. Field/category matching is diagnostic classification,
not proof of a rejected value; unknown categories cannot be diagnosed more
precisely from this envelope alone. It does not promise full provider payload
retention. An available original warehouse job ID gives an operator a precise
existing-job lookup instead of needing to rerun collection.

Errors are rethrown unchanged. Batch size, pagination, requests, retries, selected
windows, staging cleanup, promotion transaction, failure-status update topology
and watermark SQL are unchanged. No new destination/control tables or schema
migration are needed. No collector is invoked to test or demonstrate this fix.

## Local validation and review

New tests use the actual installed SDK error constructor with synthetic rows and
stub all warehouse/source I/O. They cover empty-message nested failures, bounded
redaction, staging failure with no promotion/watermark advancement, promotion job
identity, fetch failure with no retry and unchanged exception identity. Existing
finance tests retain transaction/rollback, typed timestamps, pagination, preflight
and recovery/reconciliation checks.

Run the focused source tests with installed dependencies:

```sh
node --test test/shopify-finance-failure.test.js test/shopify-finance-refresh.test.js test/collector-runner.test.js
```

The credential-dependent live preflight/dry-run test is intentionally skipped
without its explicit opt-in. This PR does not perform a live dry run, production
write, restart, collection or historical repair. Review this logging change
separately; merging/deploying it does not authorize a collector run. It cannot
reconstruct old empty records or verify retention transaction completeness.
