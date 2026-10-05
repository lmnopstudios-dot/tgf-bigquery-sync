# Oracle calendar routing and Black Friday acceptance

All commands in this runbook are read-only. They do not collect, backfill, edit
knowledge, reset watermarks, or activate schedules. Run them against the intended
Render service revision and record that revision before interpreting results.

## Demonstrated implementation causes

The shared deterministic dispatcher evaluates the historical-event service before
the calendar baseline service. The event service previously treated every message
containing “Black Friday” plus “comparison” as positive intent, independently of
the UI context classifier. Thus `/agent`, interactive chat, and durable jobs could
disagree with the calendar-only CLI diagnostic. A retained event context was not
required to reproduce that precedence defect.

Durable submissions are keyed by owner and request ID. Reusing an old request ID
therefore correctly returns the old job; it is not a request for a new analysis.
The API now rejects reuse with different message text and instructs the caller to
use a new correlation ID, while identical retries remain idempotent.

The historical resolver formerly depended on the normalized `black-friday` tag
and grouped every ordinary record in a year into one campaign phase. It now merges
the tag lookup with a confirmed name lookup and resolves an explicitly online
event independently of parent and physical-store context. Retrieval outcomes and
record IDs remain in structured evidence, so failed retrieval and absent records
are distinguishable.

The governed knowledge event schema stores `DATE` start/end fields and a textual
description; it has no structured time-of-day or endpoint-timezone columns. The
phrase “midnight GMT” therefore cannot be converted safely to a different date or
instant. The online 2024 query remains bounded to the stored inclusive dates,
2024-11-08 through 2024-11-10, and the ambiguity must remain disclosed until a
governed structured timestamp exists.

Campaign-sales BigQuery failures are an independent concern. Each failed campaign
retains bounded structured `reason` and statement `location` diagnostics, while
successful campaign sections remain available. Actual SQL and typed bindings are
validated only by an authorized production request; mock tests do not establish
production acceptance.

## Render acceptance commands

Set these locally without printing the secret values:

```bash
export ORACLE_BASE_URL='https://<render-service-host>'
export ORACLE_SYNC_SECRET='<read-only agent secret>'
export ACCEPTANCE_ID="oracle-calendar-$(date -u +%Y%m%dT%H%M%SZ)"
```

Record the deployed revision in the Render dashboard, then exercise `/agent` with
a **new** ID:

```bash
node - <<'NODE'
const prompt=`Compare online ecommerce performance for April, June, July, August and September in each of 2024, 2025 and 2026. Query exactly these 15 monthly periods. Exclude May because May 2026 included a bank holiday sale. This is a calendar-month comparison, not a Black Friday comparison.
Show monthly tables and combined five-month totals by platform and currency: eligible orders, original order totals, recorded refunds, totals less refunds and compatible AOV. Use historical WooCommerce and native Shopify according to actual coverage. Exclude POS and Matrixify duplicates.
Include top shipping countries with orders, sales and AOV; returning-customer evidence with its definition and denominator; and conversion rates only where compatible traffic and conversion evidence exists. Do not infer customer continuity across platforms.
Flag other confirmed promotions within the selected months as context without changing the dates. Show applied periods, eligibility rules, missing coverage and readable collection timestamps. Successful retrieval does not establish complete collection.
Preserve available evidence if another section fails. Return evidence tables first. Do not retrieve inventory, collect data or run backfills.`;
const response=await fetch(`${process.env.ORACLE_BASE_URL}/agent`,{method:'POST',headers:{authorization:`Bearer ${process.env.ORACLE_SYNC_SECRET}`,'content-type':'application/json','x-request-id':process.env.ACCEPTANCE_ID},body:JSON.stringify({message:prompt})});
const body=await response.json();
console.log(JSON.stringify({status:response.status,request_id:body.request_id,kind:body.evidence?.kind,requested:body.evidence?.requested_months,applied:body.evidence?.applied_months,providers:body.evidence?.selected_providers,section_statuses:body.evidence?.sections?.map(x=>({period:x.requested_period,status:x.status,provider:x.provider})),optional_statuses:Object.fromEntries(Object.entries(body.evidence?.optional_evidence||{}).map(([k,v])=>[k,v.map(x=>({period:x.period,status:x.status}))]))},null,2));
NODE
```

Verify identical-ID retry idempotency by running the same command again. Then set
a new `ACCEPTANCE_ID` before any changed prompt. A changed message under the old ID
must return `409 ORACLE_REQUEST_ID_CONFLICT` rather than an earlier job result.

For the UI path, log in normally, start a fresh conversation, submit the natural
prompt above, and repeat it after first asking: “Compare the last 3 Black Friday
sales.” In both cases verify 15 requested/applied months, no May or November sales
section, all applicable provider statuses, and persisted structured evidence from
the durable job status endpoint.

Separately submit this positive control:

> Compare the last 3 Black Friday online sales using confirmed governed event
> records. Keep parent and physical-store events as context only, preserve record
> IDs, and do not expand an online event to their dates.

The 2024 resolved online event must be
`ev_d62be9ed-527e-403a-a661-cb2d11095ca5`, 2024-11-08 through 2024-11-10. The
parent `ev_9eb3d3c7-1645-40d5-9f87-c9eeb1cc68fc` and store records
`ev_35c7f84c-75aa-44df-9878-e1e76676f898` and
`ev_4f0a2bbe-6f60-4c09-bf4c-1dfb8f421309` must remain context, not date extenders.
Inspect `knowledge_retrieval`: a failed query is not an absent event.

Finally, for any campaign-sales failure, capture only the returned sanitized
failure `reason` and `location`. An authorized production execution is the required
typed-binding validation; do not infer that a routing correction fixed a SQL 400.
