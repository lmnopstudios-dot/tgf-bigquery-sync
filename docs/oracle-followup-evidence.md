# Follow-up scope, evidence and New question

Oracle resolves an analytical question once at the UI submission boundary. The internal agent transport sends the original question separately from the validated scope snapshot. It does not concatenate prior answers or serialized context into the question, and the agent consumes a resolved snapshot without reclassifying it. Model fallback receives a validated scope description only after deterministic resolution; that description never feeds the scope parser.

Compatible follow-ups retain the analytical subject and replace requested periods. For “How are mobile and desktop conversion rates this year?” followed by “What changed between August and September?” twice, every comparison retrieves September and August independently. Evidence validation checks the exact requested windows and each monthly population, rejecting stale annual sections and missing comparison sections even if an envelope claims the correct dates.

The provider pools native conversion numerators and session denominators before dividing. Supported differences are percentage points calculated from unrounded fractions. The shared presentation uses Month | Mobile | Desktop for the complete monthly device report, exposes supported changes, preserves provider limitations and successful periods, and keeps detailed numerators and coverage collapsed. Current-day warnings require evidence that actually includes the cutoff day. Conversion charts are built from the authoritative populations, including on persisted-result recovery.

The visible New question button calls the protected analysis-clear endpoint. It clears pending clarification, scope and retained evidence, preserves visible history and leaves jobs running. Interactive and durable submissions also accept `new_question: true`. Explicit subject changes continue to work independently. A reset generation travels in a session cookie and job payload; polling a pre-reset job can display its saved result but cannot restore analytical scope or cache. Interactive completions started before reset have the same protection. After a router restart, recovering a current-generation durable result restores its validated scope. Export manifests remain readable after reset but do not establish implicit scope.

## Validation

`node --test` exercises the real dependency factory, provider arguments, shared dispatch, internal agent request builder, presentation, chart construction, HTTP submissions, durable workers and recovery. Synthetic tests do not contact production providers or mutate source data. When running the full suite in the configured cloud environment, remove inherited inventory location selectors for the command so synthetic inventory fixtures are independent of live configuration:

```sh
env -u SHOPIFY_INVENTORY_LOCATION_ID -u SHOPIFY_LOCATION_ID node --test
```

Offline browser acceptance runs the actual Oracle page against a local shared router and synthetic provider rows, at desktop and mobile sizes:

```sh
ORACLE_BROWSER_DRIVER=/path/to/playwright-core/index.mjs node diagnostics/oracle-followup-browser.mjs
ORACLE_BROWSER_DRIVER=/path/to/playwright-core/index.mjs node diagnostics/oracle-presentation-browser.mjs
```

Remaining live checks after an approved deployment: repeat the three-question sequence with real source evidence; confirm provider dates, numerator/denominator values, changes, chart periods and absence of October warnings; check durable recovery and New question while a job remains running. This change does not collect, backfill, mutate inventory/source/knowledge, change schedules, merge or deploy.
