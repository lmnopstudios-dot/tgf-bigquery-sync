# Square customer linkage: review-only implementation

The successful new-directory diagnostic found **1,543 native Square customer
IDs / 2,050 Square orders** with email-match candidates in the existing
Woo WW/USD and Shopify snapshot. These are supplied diagnostic results, not
verified people or the number of eligible cross-platform purchasers. This change
reuses that source and matching contract without replaying directory discovery,
coverage checks, monthly sales, collaboration or ring-sizer analysis.

`customer-identity/square-preview.js` implements the candidate bridge and journey
preview. `diagnostics/square-identity-preview.js` owns bounded read-only execution.
Neither is wired into Oracle, collectors, publication or activation. Existing
reports, accepted saved results, identity tables, ready markers, snapshot contents
and environment settings are unchanged. No replacement snapshot is prepared or
published. A later activation change requires review of the aggregate preview.

## Population and safeguards

- Deduplicate Square orders by exact native order ID using the successful
  diagnostic's latest-version ordering. COMPLETE/COMPLETED is the same native
  eligibility rule; payments contribute a customer ID only when unambiguous and
  consistent with any order-level ID. IDs are not trimmed, case-folded or matched
  by name. A missing/conflicting customer ID never becomes a cross-source link.
- Join the new `customers.square_data` directory by exact native customer ID.
  Preserve all distinct usable email observations; lower/trim only, existing
  placeholder/syntax/length exclusions, no dot/plus transformations. Reject
  multi-email profiles and addresses shared by multiple Square IDs, including
  directory IDs with no orders. All addresses of a conflicting profile are unsafe.
- Check the deployed email-reference derivation before internal matching and use
  the unchanged snapshot guard at the start, snapshot input and final read.
  Canonical references and raw addresses are never output. All candidate links
  remain analytical email evidence, not verified personal identity.
- Reject an entire snapshot reference across all sources when it has an
  ambiguous/unavailable resolution, a shared/conflicting-email flag, multiple
  native customer IDs within a source, or a native source customer that maps to
  multiple references. Exact snapshot order membership is required for online
  orders; a raw online customer-ID disagreement excludes that transaction.
- Preserve unmatched Square customer histories with a Square-qualified hash;
  missing/conflicting native IDs retain isolated order identities. Original IDs
  remain separate from analytical email references internally.
- Reuse the existing customer-journey factory's raw Woo/Shopify order reader.
  Deduplicate by source/order before identity joins. Apply the same status,
  cancellation, positive-net-total and Matrixify-import exclusions; guest
  orders may participate through existing safe snapshot evidence. Woo originals
  count once; Shopify Matrixify copies never become extra purchases. Other
  undocumented imports or cross-source duplicate originals remain unverified.
- Use actual source order timestamps, UTC years, the technical historical floor
  and the accepted snapshot observation boundary (`2026-10-19`). Dates, not
  source/platform order or snapshot publication time, establish direction.

## Preview output

The result is a single aggregate document, checked for unexpected fields before
printing. It includes:

- Eligible, native-identified and candidate-linked orders/customer records by
  source/year, linked-order percentages and observed timestamp endpoints.
- Unique customer-record and destination-order totals for each directional
  Square ↔ WW/USD/Shopify pair. A journey means **any** eligible origin followed
  by a **strictly later** eligible destination; tied timestamps do not count.
  This is neither a first-ever-purchase nor immediate-next-order claim.
- Destination-year/location breakdowns. Customer records count once within each
  group and pair total; a customer can appear in both directions, platforms,
  years and locations. Those breakdowns must not be summed as unique people.
- Square snapshot candidates after filtering, eligible linked Square customers
  and orders, retained unlinked Square orders/IDs, linkage outcomes and online
  eligibility/import exclusions. Reasons overlap and are not a partition.

Registered native IDs and email candidate records are separate measures. Online
coverage in this preview is limited to safe snapshot members; excluded/unmatched
online orders are reported as exclusions, not inserted into a new identity graph.
Square location IDs are transaction locations, not independently certified
physical stores. Observed endpoints do not verify continuity, prior history,
first-ever purchases or complete follow-up. Sequential session reads are not an
atomic transaction snapshot; the final guard detects existing integrity failures
but is not a new snapshot publication lock.

## Bounded Render validation

From the source directory of a checkout containing this PR, with the existing
Render credentials and unchanged `email_candidate_v2` snapshot configuration:

```bash
timeout --signal=TERM --kill-after=3s 270s node diagnostics/square-identity-preview.js
```

No arguments, configuration changes, deployment, collection or publication are
part of this command. It does not activate Square. The 17 data statements each
have a 294,117,647-byte execution cap: **4,999,999,999 bytes maximum combined**.
Each SELECT has an independent free dry run and reports an estimate where
supported. Session dry-run unsupported errors are reported explicitly; only the
bounded execution establishes compilation in that case. It does not call a
multi-statement dry run complete validation. Each job is capped at 60 seconds,
with a 240-second orchestration bound and a 270-second outer shell timeout.

Only session-local temporary relations are created. Session cleanup is attempted
on both success and failure. Temporary-table storage is separately metered until
cleanup or automatic expiry; the query byte cap is not a monetary cap on storage
or a slot reservation. No persistent warehouse, identity or source data changes.
Failure output identifies the stage/phase, reason, SQL position/context and safe
provider wording; any allocated execution job is inspected before stopping.
There are no automatic data-job retries or replays. No partial counts are labelled
successful after a failed stage.

The self-contained variant at `docs/render/square-identity-preview.sh` runs the
same source with the deployed pure helpers, without installing these new modules
on Render. Run its full contents from the application source directory. Both
forms are the same diagnostic; use one, not both.

## Review gate and remaining work

Direct warehouse access here is blocked (`EPERM` on a dataset-metadata read).
There are **no newly observed production preview counts** in this PR. Run the
bounded command and review the resulting eligibility reductions, conflicts,
source/year totals and journey direction before deciding on activation. Do not
assert that all 1,543 candidate IDs have eligible later purchases.

A future reviewed extension would need an explicit versioned identity contract,
Square roster/evidence adapters, publication integrity and concurrency guards,
source coverage/follow-up certification, accepted report population/denominator
review, and a separate activation decision. The existing v2 source whitelist and
published snapshot deliberately remain unchanged here.

Local regressions execute the generated source readers, linkage, eligibility,
journeys and aggregate relations against SQLite fixtures with explicit dialect
substitutions, plus a session/SDK double for the real runner. They establish
behavioral and query-shape regressions, not live BigQuery compilation.

## Validation in this workspace

- 27 focused tests passed: all seven new preview cases plus existing historical
  v2 resolution, preview and snapshot-publication-integrity regressions.
- The self-contained command's body is checked against the tested modules;
  JavaScript and shell syntax checks passed.
- Current upstream identity guard/reference helpers match this checkout; upstream
  collaboration work changes other journey-factory branches, while the raw
  order reader and relation parser reused here are unchanged.
- Direct warehouse metadata access returns `EPERM`; no production data stage ran.
- Full Oracle acceptance did not complete: existing fixture subprocesses blocked
  on stdin and were terminated. Separate collaboration HTTP regressions failed
  because no localhost listener was available (`server.address()` was null).
  The browser gate cannot load the missing `playwright-core` dependency. These
  gates are not claimed as passing; the draft PR is not ready for release or
  activation without the required checks in a capable environment.
