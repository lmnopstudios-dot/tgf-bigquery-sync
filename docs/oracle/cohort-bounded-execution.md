# New cohort acceptance failure: bounded execution investigation

Status: blocked on exact-job plan evidence; production acceptance has not passed.
Base: latest main 87cf8e270e195fd76a1fde88b848b08c833b96e8 (merged #343).
No provider SQL, timeout, source data, classifications, queue schema or deployment is changed.

## Current incident only

Request 7bf886e3-89d0-4273-a208-173b44afc8b0; job
81520f6a-66fe-4114-92e0-b4a2e6b43bd9; SQL SHA-256
7a0f2f0489251e09bee5759eb7732c38dea9b546ad64bbadd7f3a6577e50c61f.
Operator reports authentication 165 ms, successful dry run 8,214 ms,
population deadline failure 15,407 ms, submission response approximately
9,995 ms into execution, cancellation requested and acknowledged, no completed
cohort results. These are client observations. They neither identify the dominant
warehouse operator nor prove that the warehouse had only five seconds to compute.
Cancellation acknowledgement does not establish terminal completion.

The exact-job bounded metadata read here failed with HTTP 403. An initial
sandbox attempt failed EPERM before the network-enabled attempt. Neither returned
job metadata. The job location US is inherited from the prior incident evidence;
it is not independently verified for this new job. No old cancelled job was read.
No cohort query was submitted, and no live calculations or delivery were verified.

## Single indispensable read-only diagnostic

In an isolated checkout of this PR on the existing production host with its
configured credentials, run the command below once. No deployment is needed.
It makes one jobs.get metadata read, no SQL submission, result fetch, cancellation
or source write. The helper waits at most five seconds; the process at most eight.
It prints all plan stages up to 100, explicitly reports truncation, includes safe
operator kinds and configured bounds, and excludes SQL text, parameters, error
messages and operator substeps. Do not filter out early/complete stages.

```bash
timeout 8s node diagnostics/oracle-bigquery-job.js \
  --job=81520f6a-66fe-4114-92e0-b4a2e6b43bd9 \
  --location=US \
  --sql-hash=7a0f2f0489251e09bee5759eb7732c38dea9b546ad64bbadd7f3a6577e50c61f
```

A false/null hash match, missing plan, truncated plan or wrong location leaves
attribution unverified. This requests evidence for the new job, not another
acceptance retry or another run of the monolithic population query.

## Execution design constraints and decision gate

The existing source pipeline independently authenticates, validates SQL, then
executes within 15-second stages and a 30-second source cap in the diagnostic.
Oracle retention separately has a request deadline (default 45 seconds).
The durable worker's eight-minute runtime and nine-minute lease do not grant a
provider additional execution time. Reusing that runtime as a query timeout
would merely conceal the acceptance failure.

A candidate decomposition is: source-qualified historical eligible orders and
first/next order selection; governed classification of the entry/next order
lines; then named membership, coverage and exact retention aggregation. Choose
materialisation boundaries only after the new plan identifies repeated work,
fanout, spill or the critical active stages. CTE boundaries alone do not establish
materialisation. A failed 15-second monolith does not establish that any proposed
stage fits 15 seconds. There is currently no evidence-backed stage budget that
can be claimed to complete production.

Any implementation must retain the full historical lookback before first-order
selection, source/store-qualified identities, strict later timestamps and tie
rules, current governed identity/classification resolution (including conflicts,
revocations and effective dates), overlapping collaboration/piece membership,
calendar-day maturity and mature-only exact median inputs. Partitioning by entry
date before historical ranking or averaging partition medians is invalid.
Persisting only aggregate repeat counts cannot reconstruct exact medians.

Materialisation in an expiring analysis-owned destination would be an explicit
new storage contract, never a write to source datasets. It needs a fixed evidence
snapshot/cutoff across stages, source-qualified scope and SQL/parameter hashes,
expiry and total row/byte limits, and a manifest of completed stages. A snapshot
must cover both source orders and governance; changing classifications between
stages must not silently change membership. No such storage is created here.

Durable checkpoints must be fenced by owner, claim token and unexpired lease,
with deterministic stage job identifiers persisted before submission, recovery
by job identity rather than provider replay, authenticated result access, and
cancellation of outstanding owned jobs. Existing claim-fenced result checkpoints
are not yet a stage manifest. Expired leases cannot accept late rows. Completed
independent source/group evidence must survive other component failures and
presentation recovery must not rerun providers.

Before submission, reserve validation, submission/polling, evidence validation,
checkpoint and terminal delivery time from a fixed absolute source/request
budget. Each stage must fit its allocation; cumulative billed bytes and elapsed
time must remain bounded across stages (splitting queries cannot multiply the
20-GB cap). Insufficient remaining time must stop before allocating another job.
Budget sizes require measured complete stage runs; neither supplied timings nor
a dry run establish them. There is no timeout increase or speculative execution
path in this PR.

## Acceptance still required

1. Complete native Woo WW collaboration and piece calculations at the fixed
   cutoff; reconcile all coverage partitions, denominators, exclusive repeat
   buckets, overlapping membership, exact medians, rankings and truncation.
2. Independently complete Woo USD and Shopify with their own source/channel,
   migration, cancellation and governed classification semantics.
3. Verify direct /agent, chat, lease-owned persistence, authenticated polling and
   browser refresh against those validated results without provider replay.

Local tests of metadata extraction are not any of these production checks.
The requested completed production outcome remains unfulfilled until those
checks pass. This PR provides the bounded diagnostic and design constraints,
not a completed execution optimisation.
