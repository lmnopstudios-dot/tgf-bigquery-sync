# Cohort job deadline and cancellation evidence

Fresh branch from main e1f1b4d after merged #340. No SQL, analytical semantics or evidence deadlines changed.

Operator evidence: request b3899896-fd41-47ae-9f56-ef98f5dee7eb, job b18574c0-16a9-4a9c-b877-c097c9545782, SQL SHA-256 40d47aa0971b60b774668396a8fd4d0aa27db5404e17dec0a0cb4d353c9c7e91. Authentication 273 ms; dry run fulfilled in 10,566 ms; population stage rejected at 15,007 ms; submission response at approximately 10,269 ms. About 4.7 seconds remained for retrieval. Cancellation was requested, with no supplied acknowledgement or terminal observation.

These client timings establish stage exhaustion, not a BigQuery execution bottleneck. Submission can include server work; the response timestamp is not execution start. Planning, execution and polling attribution remains undetermined without job metadata. No arbitrary timeout increase or speculative query rewrite is justified.

## Actual access attempt

The workspace attempted one jobs.get through the existing SDK credentials, with US as an unverified location selector. OAuth refresh returned HTTP 403 `Domain forbidden`, before BigQuery metadata could be read. A second attempt through the new bounded command likewise returned 403. The correct job location must be supplied from production; no location sweep or job listing was performed. Final state, errors, server times, cache, bytes, slots, physical plan and cancellation outcome remain unknown. Full production execution and returned cohort calculations are unverified.

The enforced environment network policy has no user destination rules for OAuth/BigQuery. Use the supported environment configuration workflow to enable those endpoints, or run this command in the existing production runtime. Do not change proxy paths or credentials to bypass the policy.

## Read-only job inspection

```bash
node diagnostics/oracle-bigquery-job.js \
  --job=b18574c0-16a9-4a9c-b877-c097c9545782 \
  --location=ACTUAL_JOB_LOCATION \
  --sql-hash=40d47aa0971b60b774668396a8fd4d0aa27db5404e17dec0a0cb4d353c9c7e91
```

One jobs.get, no retries, five-second local bound; no SQL submission, result retrieval, collection, mutation or cancellation. The output omits SQL text, query parameters, row data and error messages. It includes hash verification, final status/error reasons, creation/start/end times, cache status, bytes, slot usage, up to 100 plan stages and 30 timeline samples. A missing field remains null. Creation-to-start is pre-execution time, not proof of planning cost. Start-to-end and stage metrics describe server execution; neither directly measures network result polling. DONE alone is not proof that cancellation stopped the job; `stopped` is reported separately.

After inspecting the job, compare its server intervals and errors with the client events. If it completed successfully before client expiry, investigate polling/transport; if still running at expiry, use the server plan before optimizing or reallocating the existing budget. If execution failed, fix the reported error first. A cache hit cannot establish uncached performance.

## Demonstrated lifecycle fix

Previously boundedQuery launched cancellation without awaiting any outcome, so a completed diagnostic could omit its eventual acknowledgement. Now failed allocated queries receive a separate, bounded one-second cleanup wait. Evidence ownership ends before cleanup begins. Cancellation acknowledgement and one terminal metadata observation are distinct events; a pending/failed cleanup is explicitly unverified. Late allocation still triggers cancellation exactly once, even after the original caller returned. Such late completion can only emit lifecycle events, never evidence. The callback/logger remains the observation path for late allocation; a returned diagnostic snapshot cannot predict its future outcome.

Query response events now carry job identity/location immediately, before the interruption check, so even late allocation can be correlated. Results also check elapsed and absolute ownership deadlines before delivery, including when synchronous work delays the timer callback. Existing durable claim-token/lease fencing rejects stale checkpoints and final writes. Cleanup does not renew leases or permit provider replay.

## Required production follow-through

After metadata access is restored, inspect the exact supplied job and verify its SQL hash and cancellation state. Run the existing aggregate-only full cohort diagnostic with dry-run validation, billing cap and bounded execution at the same cutoff/source. Compare complete returned rows and coverage, mature 90/180-day denominators, repeat classifications and medians against independent calculations; fixture success alone is insufficient. Preserve independent source failures rather than treating them as zeros. Production diagnosis and performance changes are pending that evidence.

## Local validation

Acceptance gate: 540 passed, zero failures/skips. Browser gate: 21 conversations passed on desktop/mobile with durable refresh. Focused cancellation, metadata, source deadline isolation and durable ownership tests: 26 passed. These verify local lifecycle behavior and fixture calculations, not the production BigQuery job or production cohort values. Browser tooling was installed under /tmp without repository dependency changes.
