# #383 complete diagnostic decorrelation

**Completed:** both budget-corrected diagnostic executions passed. Do not run the execution command below again. The supplied paste omits the trace and leading mapping rows; use the [metadata/result-only retained-result read](retention-completed-results-383.md#one-bounded-completed-result-read) instead.

## Confirmed production evidence

Mapping job `5ea59130-38b9-4b19-b567-2c0f885bd105` failed at CTAS 117:2. Updated entry-age job `72e0ddf4-0a3e-4f83-a25a-a880d8997baf` failed at CTAS 145:2. Both retained errors say: “Correlated subqueries that reference other tables are not supported unless they can be de-correlated.” The supplied paginated discovery completed with 247 records over ten pages and found the mapping execution. **Discovery is complete and must not be repeated.** The five earlier successful evidence reads remain preserved.

These locations identify the final CTAS statements rather than one uniquely rejected inner expression. Inspection of the complete final SELECTs found multiple table correlations. This fix removes those diagnostic correlations together instead of attributing the generic error to just one expression.

## Query changes and count preservation

- Mapping review now aggregates approved routes by source reference, conflicts and names by subject, and families by parent reference. Persisted SKU matches aggregate by Woo source and Shopify product before joining names/families; the final candidate array aggregates by Woo source. Empty arrays remain empty for missing evidence. Named-target filtering, title minimum, distinct SKU evidence, 11-candidate and 20-route limits remain intact. Archived eligible sales still participate; no relationship is inferred or approved.
- Mapping route-consumption flags now join distinct resolved named values and aggregate booleans per source/product before counting distinct products. Duplicate order lines or several resolved names cannot multiply the counts. The review queue and catalogue retain their independent projections and row bounds.
- Entry-age attribution now builds distinct named line keys and distinct named order keys, then left-joins them to historical lines and global first orders. Missing/conflicting classifications remain unmatched. Candidate-only products use an explicit anti-join and never become governed membership. Historical rows retain `SELECT DISTINCT`; all order/customer counts keep their original distinct keys.
- Trace product totals aggregate before joining one route-array row per source reference. Product inventory totals, dates, empty route arrays and the independent stage-count grid are preserved. Missing governance still retains a target and unknown stage counts; it is not converted into zero customers.

The diagnostic's previously corrected active-group/name left join is preserved. The accepted business-report factory, execution mechanism, eligibility exclusions, linked snapshot and provisional/verified coverage rules are unchanged. No persistent table or governance decision is written. All twelve accepted business-report full SELECT and synthetic query settings are byte-identical to the preceding reviewed artifact.

New regressions inspect both complete generated diagnostic shapes and their actual staged final CTAS. Local SQL fixtures compare old/new trace membership flags with duplicate lines/names, prior cross-platform entries, conflicting/missing classification and candidate-only products; mapping fixtures cover duplicate SKU pairs and route-consumption distinct counts. These SQLite compatibility executions and shape assertions **do not establish BigQuery compatibility**. The command below executes both complete corrected production diagnostic scripts against existing warehouse data; it does not stop at a dry-run DDL.

## Diagnostic script budget correction

The next live attempts reached explicit bytes-billed limits: mapping reported a requirement of **178,257,920 bytes**, trace **136,314,880 bytes**. Inspection found `maximumBytesBilled=500000000` on each entire script and `scriptOptions.statementByteBudget=500000000` per statement. The two diagnostic jobs were therefore capped at one statement's allowance for the whole script, despite the already reviewed multi-statement bounds.

Only those two job caps change: mapping **5,500,000,000 bytes** for nine input CTAS + result CTAS + final SELECT; trace **6,000,000,000 bytes** for ten input CTAS + result CTAS + final SELECT. Each data statement remains capped at **500,000,000 bytes**. Both reported required-byte figures fit under that unchanged cap; they do not establish cumulative script cost. No cumulative usage is invented here. The shared audit allocator/defaults, other diagnostic callers and production report budget are unchanged.

The regenerated artifact differs only in those two whole-job fields: SQL, parameters, script options, deadlines, portable runner and the five control queries compare identical. A regression checks the 11/12-statement allocation, the reported requirements, unchanged statement/time limits and unaffected shared/production allocators. Live execution remains pending the two-job command below.

## One targeted Render follow-up command

Run from deployed `src`; no deployment is needed. One immutable artifact contains both corrected scripts. Exactly two independent diagnostic jobs are permitted, each retaining its own success or error. No ingestion-control reads, retained-error discovery, source collection or report replay occurs. Existing per-script limits remain 50 seconds warehouse, 55 seconds client, 15 seconds/statement and 500 MB/data statement. Mapping uses ten temporary input tables plus final result materialization; trace uses eleven plus final materialization. The command changes no production report limits.

Both diagnostic executions have completed. The execution command is retired; do not submit either script again. Use the [single metadata/result-only command](retention-completed-results-383.md#one-bounded-completed-result-read) to recover the completed envelopes. The previous execution command remains in Git history.

Mapping execution returns raw governed/SKU evidence, required review actions and impact counts; candidate relationships still require the existing graph-safe review workflow. Successful execution of these diagnostics would establish query compatibility and return current warehouse evidence, not certify transaction coverage or approve mappings. The zero-denominator cause remains unresolved until the trace's returned stages are reviewed.

## Validation status

All 18 focused tests pass. All 836 required acceptance tests pass (21 central conversations and 60 provider/delivery suites), along with desktop/mobile browser gates including durable and activated-identity refresh. The published budget-corrected artifact was fetched back and its SHA-256 verified. Development Google access remains blocked by OAuth 403 `Domain forbidden`; the user-supplied completion record confirms both corrected BigQuery executions and envelope validations passed. The supplied paste omits trace rows and leading mapping rows; only retained-result retrieval remains, with no re-execution.
