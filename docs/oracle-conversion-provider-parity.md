# Oracle conversion provider parity acceptance

The diagnostic is bounded, aggregate-only and read-only. It uses the same production dependency factory and device-conversion adapter as the server. It neither collects nor backfills data, changes knowledge, resets watermarks, nor changes schedules.

## Render acceptance

Run in the Render service shell for the deployed revision:

```sh
npm run diagnose:oracle-woo-historical-provider > /tmp/oracle-woo-provider.json
node -e "const x=require('/tmp/oracle-woo-provider.json'); if(x.months.length!==10||x.months.some(m=>m.status!=='fulfilled'||m.classification!=='usable_stored_evidence')) process.exit(1); console.log({project:x.mapping.project,dataset:x.mapping.dataset,location:x.mapping.location,months:x.months.map(m=>[m.month,m.classification,m.coverage.covered_days,m.coverage.expected_days])})"
```

Then submit the exact ten-month prompt through `/api/oracle/chat` and, when durable analysis is enabled, `/api/oracle/jobs`. Use the browser session cookie and CSRF value issued by `/api/oracle/auth/login`; do not paste either into logs:

```sh
curl --fail-with-body -sS -b "$COOKIE_FILE" -H "Origin: $ORACLE_ORIGIN" -H "X-CSRF-Token: $ORACLE_CSRF" -H 'Content-Type: application/json' "$ORACLE_ORIGIN/api/oracle/chat" --data @/tmp/oracle-woo-request.json > /tmp/oracle-live.json
node -e "const x=require('/tmp/oracle-live.json'); if(!x.success||x.evidence?.sections?.length!==10||x.evidence.sections.some(s=>s.status!=='fulfilled')) process.exit(1); console.log({kind:x.evidence.kind,providers:x.evidence.selected_providers,months:x.evidence.sections.map(s=>[s.period.start_date,s.status,s.availability])})"
curl --fail-with-body -sS -b "$COOKIE_FILE" -H "Origin: $ORACLE_ORIGIN" -H "X-CSRF-Token: $ORACLE_CSRF" -H 'Content-Type: application/json' "$ORACLE_ORIGIN/api/oracle/jobs" --data @/tmp/oracle-woo-request.json
```

Correlate live failures by the returned `x-request-id` and server stage diagnostics. Diagnostics expose only provider operation, stage, safe code, HTTP status, BigQuery reason and statement location; prompts, credentials, customer rows and raw exception messages must not be logged.
