# Square reporting activation proposal — approval required

This is a prepared plan, not an activation. No record below has been written,
no Render setting has been changed, and no report should be replayed as part of
this preparation. The base identity snapshot and all mapping decisions stay intact.

## Release and deployment status

At preparation, PR #411 is open, draft and unmerged. The running Render health
endpoint returned revision `5126c28d5c3c26657440c801da74e8efc214f884`, which does not
contain #411. A temporary-checkout diagnostic is **not** a deployed release.

GitHub run 41635470484 passed acceptance, then failed before browser tests:
`Playwright does not support chromium on ubuntu26.04-x64`. The workflow used
`ubuntu-latest` with Playwright 1.56.1. It is now pinned to `ubuntu-24.04`; this
changes the test environment, not application/provider behavior. The first browser
run on that host exposed a retained-spreadsheet refresh-message bug: the cache
used the source response as its displayed answer. Source and display answers are
now stored separately; export refresh and repeated-export HTTP regressions verify
that the confirmation survives without provider reads or changed source notes.
Require the
acceptance and desktop/mobile browser steps to pass before release. Do not count
an installed browser or a successful acceptance-only step as browser validation.

Native channel proof is already supplied for commit
`586db4f35db59e526a62493c9bc8e5f1c793dc31`:
job `square_channel_validate_174f621c095b44c3abe1bf8b39c4c9e7`, 27,912 supported
in-store orders out of 49,840 eligible Square transactions. The subsequent
completed coverage check, using that resolver, established 16,852 identifiable
in-store Square orders and 13,913 first-observed in-store entry records.
Do not rerun those diagnostics. Do not infer that every entry record is a verified
person, first-ever purchaser or part of an email-linked cross-platform journey.

## Exact proposed reviewed record

Destination: `gf-full-data.customer_identity.identity_reporting_extensions`.
The **proposed** row is:

```json
{
  "extension_id": "square_channels_v1_history_20261022_billing_v3_review_20261103",
  "state": "reviewed",
  "reporting_version": "square_channels_v1",
  "identity_version": "square_native_email_v1",
  "base_snapshot": "history-20261022-billing-v3"
}
```

`state=reviewed` is the post-approval value required by the existing guard. It is
not a claim that an independent approval has already occurred. The guard requires
exactly one row for this ID, with all four other values matching. It fails closed
on missing configuration/table, duplicates, a wrong snapshot/version or failed read.

The exact proposed SQL is [square-reviewed-extension-proposal.sql](square-reviewed-extension-proposal.sql).
It creates only the extension-review table if absent, and inserts only this row
if absent. It stops on an existing conflicting, revoked or duplicate record;
it does not overwrite other reviews. Inspect any existing table schema before
execution: extra required columns may need the owner's explicit review. It does
not change that existing schema. Execute once, after approval, not concurrently.

To print the proposal locally without any warehouse or Render access:

```sh
node diagnostics/square-activation-plan.js
```

There is no execute mode. This prints the record, settings, proposed SQL and
read-only guard query; it performs no network call or write.

## Exact Render settings

Add only these two settings after approval:

```text
ORACLE_SQUARE_REPORTING_VERSION=square_channels_v1
ORACLE_SQUARE_REPORTING_EXTENSION_ID=square_channels_v1_history_20261022_billing_v3_review_20261103
```

Verify and preserve the existing identity settings:

```text
ORACLE_CUSTOMER_IDENTITY_MODE=email_candidate_v2
ORACLE_CUSTOMER_IDENTITY_DATASET=customer_identity
ORACLE_CUSTOMER_IDENTITY_SNAPSHOT=history-20261022-billing-v3
```

No replacement snapshot, source publication, collector run, mapping approval or
IAM expansion is part of this plan. The runtime needs read access to the reviewed
marker; do not speculate about widening service-account permissions.

## Approval scope and execution order

The approval would authorize exactly:

1. Merge #411 after required release gates pass, deploy that release, then check
   that the live revision contains the approved channel-fix commit. Keep the
   Square settings off during this deployment verification.
2. Independently approve the record above and execute its proposed SQL once.
   Do not republish or extend the base `identity_order_links` snapshot table.
3. Add the two Square settings in Render and redeploy/restart the existing
   application. Recheck the unchanged identity mode/dataset/snapshot.
4. Run only the prepared read-only guard query (printed by the plan command)
   against the exact review ID. It reads the small review table, not transaction,
   mapping or customer data. Require `reviewed_extension_matches=true` and the
   correct live release revision. Do not run reports automatically.

Only subsequent explicit user report requests may execute business reports.
The preparation itself does not authorize these steps. Stop if CI/deployment,
table schema or marker checks fail; do not substitute a legacy population.

## Scope controls and disclosures

Global capability enablement does not include Square by default. Existing saved
reports and requests with no journey scope retain their legacy SQL/population.
In Oracle, start a new question, enable separate entry/follow-up filters, then
explicitly select Include Square. New question clears that selection. Entry and
follow-up remain independent (`all`, `online`, `instore`), and the next-purchase
rule remains explicit (`anywhere_then_filter` versus `next_matching_channel`).
Unknown channels remain in full-history chronology but cannot satisfy an
online-only or in-store-only filter. Native unmatched histories stay source-local;
unsafe email candidates are rejected. No location-name/title inference is added.

Disclose the unidentifiable 2021–22 Square gap, incomplete prior history and
follow-up, partial mapping/classification coverage, overlapping cohorts and the
smaller cross-platform email-candidate subset. Counts/age-qualified rates remain
provisional; verified retention rates remain unavailable without independent
continuous coverage evidence. Neither endpoints nor this review row certify it.
The retained named-collaboration source counts were all-channel; do not present
them as in-store-specific results.

## Rollback

Remove the two Square settings and redeploy. Square-inclusive requests then fail
closed; legacy requests remain unchanged. Keep the review row as evidence unless
a separately approved revocation is needed. Do not delete source data, mappings,
identity links, saved reports or the accepted snapshot.
