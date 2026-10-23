# Complete item result transport

Production evidence for request `e62ba500-243a-460b-b389-8693aa17e5b0` shows the item script completed successfully in 37,527 ms. All 24 listed child jobs were DONE with no provider error. The client nevertheless reached its 45-second ownership deadline while awaiting/retrieving results. Those observations do not establish a SQL syntax, mapping or classification defect.

The generated query repeated shared product rankings, source diagnostics and classification coverage on every item/window row. The item final SELECT scanned 22,275,570 bytes from its result table. That scan statistic is not a measurement of HTTP payload size and does not by itself prove how much of the deadline was retrieval time.

This change compacts those shared arrays onto one designated aggregate row: cohort rank 1, 90-day window, or the empty-result coverage row. Other item rows carry typed empty arrays. Every eligible item/window row, its counts, per-item second-order products, attribution-unknown counts and completeness total remain present. No page/item/window filter is added. The reader locates the designated row instead of assuming the first SDK result page contains it; legacy repeated metadata remains readable.

A 720-row pagination fixture puts the designated row on the third page. The service produces identical normalized item calculations, shared coverage and rankings before/after compaction, with a synthetic serialized response more than 90% smaller. This is a fixture payload measurement, not a production latency guarantee. The interactive/durable and desktop/mobile fixtures also place the compact metadata row last, retaining all 240 items and their three windows.

The shared predicate is confined to collaboration-item projections. Named collaboration totals and sitewide SQL are unchanged. The 6,000-row safety bound, strict item completeness, frozen identity, classification/family rules, imported-order exclusions, coverage semantics, statement/request timeouts and warehouse billing ceilings are unchanged. There is no automatic report replay, cancellation retry or persistent business-data write.

`test/retention-compact-result-sql.py` executes the generated final projection after documented local DuckDB/SQLGlot dialect adapters (inline ARRAY_AGG LIMIT, STRUCT star expansion and local ordering qualification). This verifies the conditional metadata placement and per-window counts locally, not native BigQuery compatibility. Native compilation and the deployed report's latency/completeness remain live acceptance requirements.

After release, submit the full collaboration report once. Accept the item section only when it reports equal returned/total item groups and all three windows, retains whole-range rankings and baseline results, and has no item calculation failure. The completed historical script need not be rerun as a diagnostic.
