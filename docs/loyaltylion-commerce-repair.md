# Targeted commerce repair for the LoyaltyLion assessment

The source comparison identified 39 affected orders: two missing finance/customer/
channel rows, plus stale eligibility, links, cancellation, refund and gross values.
Counts can overlap. This tool prepares a fresh bounded target set, not a broad
historical backfill. Nothing runs on import, deployment or a schedule.

## Review, then preview

Wait for acceptance and browser CI to pass, review the PR, merge and deploy.
Do not reuse the expired temporary ID-only plan from the previous deployment.
The new preview reruns the source comparison and prepares fresh affected rows.

Before the final preview/apply sequence, pause the finance and customer Render
crons and drain any active manual/other writers to these tables. Keep them paused
until publication is reconciled. This operator barrier is required because the
finance writer does not share the new repair guard; an empty manifest alone does
not establish that another writer cannot start. No script automatically pauses
or changes a schedule.

From a fresh Render Shell:

```bash
timeout --signal=TERM --kill-after=5s 16m \
node shopify/commerce-repair.js preview \
  2025-11-16T00:00:00Z 2026-11-16T00:00:00Z
```

The source/warehouse reads reuse existing connections. No new secret files or
LoyaltyLion credentials are needed. Progress prints every 15 seconds. The preview
creates only a private 0600 local file in a new 0700 temporary directory and
prints aggregate counts, run ID, expiry and file path. It includes prepared rows
and preserved warehouse values internally; never print or paste its contents.
The complete source audit's 25,000-row, 250-page, 320-call/64 MB/15-minute caps
remain. At most 100 exact affected orders can be prepared. Additional targeted
reads use batches of ten, rate spacing and at most two throttling retries; no
sampling or automatic cap increase. Preview files are limited to 16 MB and expire
after 30 minutes. Deleted/retained-only orders require investigation, not deletion.

Preview reads schemas and all retained snapshots for target fingerprints. It
preserves unknown existing columns and names for unchanged customer links (clearing stale names when a customer link changes), encodes NUMERIC/large
integers as exact strings, and prepares current source finance/customer/channel
values. Missing required fields, incompatible schemas, expiry, incomplete source
reads, detected concurrent source updates and invalid amounts stop preparation.
There is no warehouse staging, DDL or DML in preview. No differences means no file.

## Separately gated apply

Review the final preview counts and run ID first. Only after explicit repair
approval, with competing collectors still paused, use its actual printed path:

```bash
SHOPIFY_COMMERCE_REPAIR_ENABLED=true \
timeout --signal=TERM --kill-after=5s 16m \
node shopify/commerce-repair.js apply \
  /tmp/tgf-commerce-repair-REPLACE/preview.json \
  --confirm-collectors-paused
```

The flag is per invocation; do not enable it on the service or cron. This command
is the explicit warehouse write. It does not change Shopify, LoyaltyLion balances,
stock, schedules or the finance/customer collector watermarks. It refreshes order
financial totals, customer/eligibility evidence and channel rows only; refund-event
detail rows, line items and other datasets are outside this repair's scope.

Apply re-reads exact source IDs and warehouse fingerprints, verifies the preview
integrity, rederives its candidate rows rather than trusting edited payloads,
checks source/schema/state freshness and retention, and refuses stale previews.
All three permanent targets and repair control tables must have no table or
partition expiry. Setup creates only the separate repair run manifest and singleton
guard, with permanent retention explicitly set and verified. A held/unresolved
repair cannot be taken over automatically.

Prepared rows load into separate schema-matched stages with a four-hour TTL.
Stage failure leaves live order rows unchanged. Source freshness is checked again
after loading. The final transaction asserts the owned repair guard/run, no active
finance/customer runs, an idle customer guard, unchanged target-row fingerprints
and unchanged collector-state hashes, and complete exact scoped stages. It appends
new timestamped snapshots to all three live tables and marks the repair committed
and guard released in the same transaction. It never deletes old history. Existing
report readers choose latest snapshots. No scheduled watermark is updated.

One preview/run cannot append twice: target/state changes and the durable run
marker reject a repeated apply. Refreshing both fields and staged content from
source prevents edited candidate rows from being accepted even if a local checksum
is recomputed. Schema uncertainty fails closed rather than dropping extra columns.

## Failure/recovery and verification

Before-publication failure is recorded and the owned guard released when that
cleanup can be confirmed. Stages have explicit four-hour cleanup even on failure;
private NDJSON upload files are removed. If a control/publication result is
uncertain, do not replay, declare it rolled back or unlock automatically.

Use the preview/run ID for a read-only status check:

```bash
node shopify/commerce-repair.js status RUN_ID_FROM_PREVIEW
```

A publication error reports REPAIR_COMMIT_UNKNOWN with the run ID. The allocated
promotion job ID is commerce_repair_ followed by that UUID with hyphens replaced
by underscores. Inspect its terminal result and durable marker/guard before any
manual reconciliation. A committed marker and released guard are atomic evidence
of publication; preparing/held or unavailable status remains unresolved. A failed
cleanup can also leave a guard; return status rather than attempting lock takeover.

After confirmed commit, rerun the complete read-only source reconciliation for the
same annual bounds. Only then review supported channel/date coverage for the
LoyaltyLion report. Keep older lookbacks, future cohort windows and genuine source
limitations separate. Resume paused collectors after the repair is confirmed and
retain their existing schedules and settings. No automatic certification or
LoyaltyLion report replay is part of this command.

## Repair SQL preflight regression

The first production apply failed with invalidQuery at line 1, column 356, the
unparenthesized AND in the idle customer guard. This happens before repair-control
DDL/acquisition and before staging. Compound ASSERT predicates are now wrapped as
one parenthesized Boolean expression in idle checks, acquisition, ownership and
stage counts; no guard is removed or weakened.

After the fix is reviewed/deployed, validate the exact idle-check script without
Shopify reads or warehouse writes, while competing collectors are paused:

```bash
node shopify/commerce-repair.js preflight
```

Expect idle_sql_verified. This validates idle SQL/access and current idleness;
it does not certify commerce coverage or replace the final transaction checks.
Read-only status for the original failed run remains available; if control tables
were never created, notFound is consistent with the pre-DDL failure. Do not replay
an apply merely because its source preview remains on disk. Deployment can remove
that file and all previews expire after 30 minutes: generate a fresh preview after
preflight succeeds, then separately apply the newly printed path.

## Control UPDATE regression (run 4905a490)

The second failed apply's location, line 1 column 358, aligns with UPDATE in the
acquisition script. That UPDATE lacked BigQuery's mandatory WHERE condition. The
claim now updates only WHERE holder IS NULL, after the same singleton/unheld
assertions, inside the transaction. Control claim and run-marker statements are
shared by acquisition and independent BigQuery dry-run validation. Every generated
UPDATE is tested for an explicit condition.

Preflight now runs the read-only idle checks and, when repair control tables exist,
dry-runs the exact claim and marker DML separately. It reports
control_dml_validation: dry_run_verified only if both validate; if control tables
are absent it explicitly reports tables_not_created rather than implying those
writes were checked. Apply repeats DML validation after setup and before acquiring
the lock. Dry runs never acquire a guard or create run markers. Safe progress now
identifies source/warehouse revalidation, idle checks, control setup and lock
acquisition rather than leaving all pre-staging activity labelled authentication.

The reported empty run list and singleton unheld guard do not justify replaying a
stale apply. After this fix is deployed, run preflight, generate a fresh preview,
and review its new file path before a separately gated apply. Existing guard,
source/warehouse freshness, stage and atomic publication protections remain.
