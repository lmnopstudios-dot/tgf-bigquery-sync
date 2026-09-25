# Danielle stock-clearance incident and production acceptance

## Diagnosis

The browser submits the composer value with `JSON.stringify({ message: text })`, and the API helper adds `Content-Type: application/json`; apostrophes, curly punctuation, and newlines in Danielle's email are therefore valid JSON escapes. The jobs router accepts up to 48 KB at the HTTP layer and validates the decoded `message` separately at 12,000 characters. The full email is below both limits.

The exact source of the misleading production response was the router's final error handler: **every** error reaching it, including an asynchronous durable-store/enqueue failure, was labelled `400 Invalid JSON request`. JSON parsing was not established as the failure merely because that response text appeared. The handler now emits that response only for Express's `entity.parse.failed` `SyntaxError`; it identifies the 48 KB parser limit separately, and the jobs route converts queue-write failures to a safe retryable `503` without logging the request body. Legacy payloads using `prompt`, `question`, or `query` instead of the deployed `{message}` contract receive an explicit refresh response, so a cached client/server mismatch cannot masquerade as malformed JSON.

The endpoint test uses the in-memory queue. It proves browser serialization, middleware parsing, validation, authentication/ownership wiring, and the `202` contract; it does **not** prove that Render can enqueue into BigQuery. The production failure at claim was caused by enqueue using BigQuery's streaming insert API: its newly buffered row could be selected but not updated by the claim transaction. Enqueue now uses parameterized query DML with `PARSE_JSON`, which commits before returning and makes the row immediately mutable. Owner lookup, leasing, completion, failure, and cancellation also use named parameters. EU is only the new-dataset default; every query uses the existing dataset's metadata location. The Render service account needs table metadata/read and update-data permissions plus permission to create dry-run/query jobs.

The pre-existing `commerce.oracle_analysis_jobs` production table does not match any schema shipped by the Oracle queue (the original Oracle schema already contained all twelve current fields), so it is treated as a name collision with another feature. The safe fix is the distinct Oracle-owned `_v1` table above. Startup never drops, truncates, rewrites, or adopts the colliding table. Run `npm run diagnose:oracle-job-readiness` as the first Render Shell command after deploying; it reads metadata, tests IAM, and submits only a dry run, without reading row data.

Run `npm run diagnose:oracle-job-readiness` in the Render shell before acceptance. This check is read-only: it reads dataset and table metadata, validates the complete job schema and dataset location, calls `testIamPermissions` for the exact table permissions, and submits a typed dry run of the production JSON enqueue DML (a dry run writes no row). It returns only the failing stage and a bounded error code on failure—never credentials, prompts, customer parameter values, or provider error text.

Then run this exact, deliberately opt-in Render Shell command:

```sh
ORACLE_JOB_QUEUE_SMOKE=true npm run smoke:oracle-job-queue
```

The targeted smoke does not establish that ordinary polling is healthy. After
deployment, this Render Shell command safely executes only the production
worker's read-only ordinary candidate lookup (it returns only whether a job is
waiting, never an ID or payload):

```sh
npm run diagnose:oracle-ordinary-claim
```

Then run one controlled acceptance lifecycle from a single shell. It enqueues a fixed non-customer
payload, claims it through the ordinary (not targeted-smoke) path, and completes
it without invoking Oracle analysis. Do not run multiple acceptance commands
concurrently:

```sh
ORACLE_ORDINARY_CLAIM_ACCEPTANCE=true npm run diagnose:oracle-ordinary-claim
```

The smoke command is never imported by startup. It uses the configured real BigQuery table and writes one clearly marked `oracle-smoke-*`, synthetic, non-customer job. Normal workers exclude that marker; the smoke process targets only its own job while verifying queued retrieval, claim, completion, and completed-result retrieval. It does not invoke the Oracle agent, create a table, print payloads, or print credentials. Success emits only the passed stage names. Failure emits only `failed_stage` and a sanitized `bigquery_reason`.

The `product_affinity` primary and guest BigQuery jobs both completed. They were not the terminal failure. The next agent round still had to submit their function outputs to the Responses API and obtain a final answer. The UI-to-agent request shared the same 90-second edge as the agent deadline, so a slow continuation could be aborted by the UI fetch before the agent returned a bounded response. That transport exception reached the UI router's outer catch and became the generic “The request could not be completed” message. Proposal generation happens after chat and is already optional; it cannot explain a log line emitted by the outer chat failure path.

The affinity call was unnecessary. “Use data where possible” in a broad clearance advisory did not ask which customers or products overlap. The model over-selected a generally available behavioural tool and matched an unrelated `TGF Chunky Hoop Earring (Single)` seed. Affinity remains admitted only for explicit affinity, customer-overlap, also-bought, bought-together or cross-sell intent. The durable job has no blanket tool-count cap: it is bounded by per-call cancellation, the model's round guard and the eight-minute overall job runtime, allowing the complete batched 20-item analysis.

## Safe production acceptance sequence

1. Deploy to a non-production revision and confirm startup succeeds.
2. In the Render shell run `npm run diagnose:oracle-job-readiness`; require `success:true` for all four stages. Run `ORACLE_JOB_QUEUE_SMOKE=true npm run smoke:oracle-job-queue` and require all five lifecycle stages.
3. Open Oracle and paste Danielle's complete email below, then click the single **Send** button:

   > Danielle has asked us to look at clearing the following stock online:
   >
   > Small Signet; Butterfly, Ankh, Eagle and Pig charms; Sun and Moon, Serpent, Dagger, Snake and Dagger, Magic Mushroom and Enchanted Castle pendants; Reaper and Pentagram; gold and silver bat earrings; Solid Heart and Smallest Evil Skull rings; and all three skull-hoop variations.
   >
   > Any ideas of what we can do? Use data where possible.

   Confirm the background queued/running progress appears promptly, refresh the page while it is running, and confirm polling resumes. When it completes, verify the entire answer is present (including all 20 items), the inline chart renders, and every knowledge proposal card remains available. Submit a short ordinary question with **Send** and confirm it still uses the immediate `/chat` path.
4. Confirm logs contain `request_id`, `stage`, `outcome`, `elapsed_ms`, and (only on failure) `error_class`; confirm they contain no SQL, parameter values, customer names, bearer tokens, or prompt payloads.
5. Confirm the brief does not call product affinity and that catalogue, exact-location inventory, sales comparison and final synthesis cover all 20 requested items without invented figures.
6. Let synthesis run beyond 74 seconds, refresh again, and confirm one complete answer is returned. In a separate job press Cancel and confirm it becomes `cancelled`.
7. Inject catalogue, inventory, affinity, and proposal failures independently. Confirm successful evidence and useful advice remain, unavailable evidence is labelled, and each durable claim produces no more than one proposal card.
8. Restart the staged Render service with one queued job and one deliberately running job: queued work must resume, while the expired running lease must become safely failed (never silently replayed). Run `npm test`, inspect only request/stage/outcome/error-class metadata in logs, then shift traffic gradually.
