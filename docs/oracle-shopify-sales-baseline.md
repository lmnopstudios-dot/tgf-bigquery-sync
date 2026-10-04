# Shopify operational sales baseline verification

## Cause and routing contract

The deterministic baseline classifier previously tested the broad word
`customer` before it established whether the current message explicitly asked
for a sales baseline. Consequently, wording such as “existing chat containing
earlier customer comparisons” was itself enough to select the customer route.
This was a current-message precedence defect, not evidence that Shopify returned
customer data for a sales query. The analysis-context classifier had the same
broad customer match and could retain an incompatible subject.

An explicit `sales baseline`, `sales starting baseline`, or `ecommerce starting
baseline` now wins before customer, Woo comparison, geography, funnel, and
Search Console subjects. That route calls only the Shopify operational sales
KPI provider, once for each requested calendar-month/channel pair.

## Read-only post-deployment verification

The long prompt is routed by the browser to `POST /api/oracle/jobs`, while the
same deterministic evidence plan is also available through interactive
`POST /api/oracle/chat` and authenticated direct `POST /agent`. Before enabling
background jobs, confirm `ORACLE_ANALYSIS_JOBS_ENABLED=true`, the configured
`ORACLE_JOB_DATASET`/`ORACLE_JOB_TABLE`/`ORACLE_JOB_DATASET_LOCATION` (defaults
`commerce`/`oracle_analysis_jobs_v1`/`EU`), Google credentials, and the table
permissions with `npm run diagnose:oracle-job-readiness`. This is a metadata,
permission, schema, and dry-run check; it performs no collection or backfill.

Submission failures now return and log a correlation ID. The server diagnostic
identifies the request path and stage (storage readiness, context resolution,
idempotency lookup, or job creation), a safe code/class, and sanitized
application stack locations. It intentionally never reflects exception text,
headers, cookies, request bodies, SQL values, or customer data. On an uncertain
submission outcome the browser retains the request ID; an explicit retry first
looks up that ID and reuses the existing job rather than creating a duplicate.

Set `ORACLE_URL`, authenticate in the normal way, and put the resulting session
cookie and CSRF value in `COOKIE` and `CSRF`. This command only submits a
read-only analysis request. It does not collect, backfill, schedule, truncate,
or move a watermark.

```bash
PROMPT='Establish my ecommerce starting baseline for August 2026 and September 2026, reporting Shopify Online Store separately from POS. Retrieve only governed sales evidence. Return a metric table showing orders, gross sales, discounts, returns, net sales, shipping, recorded tax, total sales, net units sold, units per order and Shopify-reported average order value wherever supported. Keep currencies separate. For each metric show its source-native metric name, definition, applied channel filter, date coverage and actual source collection timestamp where available. Do not substitute canonical finance or order-level totals for Shopify operational measures. Do not calculate units per order unless numerator and denominator are compatible. Mark unsupported metrics unavailable and preserve successful evidence if another metric fails. Return tables without requiring interpretation. Do not retrieve inventory or unrelated sources.'
curl --fail-with-body -sS "$ORACLE_URL/api/oracle/chat" \
  -H "Cookie: $COOKIE" -H "x-csrf-token: $CSRF" \
  -H "Origin: $(printf '%s' "$ORACLE_URL" | sed -E 's#(https?://[^/]+).*#\\1#')" \
  -H 'content-type: application/json' \
  --data "$(jq -n --arg message "$PROMPT" '{message:$message}')" |
jq '{selected_intent:.evidence.selected_intent,
     services_invoked:.evidence.services_invoked,
     applied_scopes:[.evidence.sections[]|{period,channel,applied_channel_predicate,status}],
     evidence_statuses:[.evidence.sections[]|{period,channel,status,error_code}],
     rendered_metric_rows:.evidence.metric_rows}'
```

To verify the browser-selected background route, send the same JSON to
`/api/oracle/jobs` with a fresh non-sensitive `x-request-id`, poll the returned
`job_id`, and require the completed result to contain the same four evidence
sections. Repeating the submission with the same ID must return the same
`job_id`. To verify `/agent`, send the same prompt with `Authorization: Bearer
$SYNC_SECRET` and a non-sensitive `x-request-id`; do not print either secret.

Acceptance requires `selected_intent` to be `sales_baseline`, the sole service
to be `get_shopify_sales_kpis`, four independently statused scopes covering
both exact months and both exact channels, and visible rows for all requested
metrics. A requested date range is not proof of complete source coverage.
Null collection timestamps and unsupported metrics must remain unavailable.
The baseline must not be called complete until live provider evidence supports
the requested metrics and scopes.
