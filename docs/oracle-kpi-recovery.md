# KPI retained-workbook recovery

## Incident and reproduced cause

Production request `a3420369-000c-46c9-99c9-71f28a74e2cf`, job
`f4725535-2976-4189-ac3d-1541e409afaa`, failed on 17 November 2026 at the
`analysis` stage with generic `ANALYSIS_FAILED`. Those retained job fields do not
identify the original exception or establish whether an export was saved.

An offline reproduction of the merged implementation produces uncoded
`KPI_ARTIFACT_INVALID` after reordering the persisted evidence's JSON object
members. That matches BigQuery's documented canonicalization: object-member
order is not guaranteed, whereas array order is preserved. See
[BigQuery JSON type](https://docs.cloud.google.com/bigquery/docs/reference/standard-sql/data-types#json_type).
The earlier in-memory fixture preserved object insertion order and missed this.
The production export store already exercised by other fixtures models
canonicalization; KPI fixtures now use that transport as well.

The reproduced bug has two causes:

1. The KPI workbook validator rebuilt column order from evidence object keys,
   although the original XLSX retained its original header order.
2. The baseline explanatory cell used insertion-order `JSON.stringify`, so even
   after header lookup was corrected the nested baseline text differed.

No production job or export was read or rerun during this repair. Recovery of
this exact production job remains conditional on a valid owned export existing.

## Repair

- A shared worksheet validator reads and verifies the original headers, checks
  the exact column set without duplicates, then compares every evidence row and
  cell by header. Row order remains strict. Zero, false, null, decimal strings,
  hashes and scope checks are not relaxed.
- KPI baseline text is now deterministic. For existing workbooks only that
  explanatory JSON cell is compared structurally; ordinary text/metric cells
  remain exact.
- The same dynamic-column validation pattern was audited and updated for
  country conversion, campaign, basket and order-value workbook validators.
  Product-report column manifests retain their existing ordered definitions;
  inventory has its own header-based validation. No providers were changed.
- KPI artifact validation failures now have code `KPI_ARTIFACT_INVALID` and phase
  `kpi_export_validation`. Export read, source read, workbook build, persistence,
  readback and delivery have aggregate phase events. Unexpected uncoded failures
  become `KPI_REPORT_FAILED` with the phase; raw messages/rows are not exposed.
- Failed KPI jobs join the existing owner-bound persisted-export recovery path.
  Polling validates the stored hash, cells, request and analytical scope, then
  returns the existing workbook. It does not call providers, collect data,
  rewrite history or resubmit the job. A missing or incompatible workbook is not
  replaced with another result.
- The dashboard now displays safe request/job references, error code and stage.
  A recovered result is identified as a saved report with no analysis rerun.

## Validation and rollout

Run the acceptance and browser gates. The focused recovery cases cover:
canonical JSON hydration, legacy XLSX headers/baseline text, tampered data/hash,
column duplicates, exact row order, null/zero/false distinctions, explicit
failure diagnostics, owner-bound recovery, changed request/currency rejection,
and missing-export behaviour without provider replay.

After an authorised merge and deployment, refresh Oracle and open **KPI
tracking**. Its saved job reference reconnects to the existing job. Do not click
**Run KPI dashboard** simply to repair the display: that creates a new analysis.
If the owned workbook exists and passes validation, the panel says **Recovered
saved report. No analysis rerun.** Download and review that workbook.

If no compatible workbook exists, the panel remains failed and shows the
request ID, job ID, code and stage. Use those to inspect the matching service
logs before deciding on an explicit new run. No automatic replay, configuration
change, source collection, production write or deployment is part of this PR.
