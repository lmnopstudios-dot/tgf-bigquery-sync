# Cohort validation deadlines — 2026-10-19

Investigation of request `18867e0e-50b8-4799-b98c-c252e8824291`.
Base: latest main `47a6a0a` (classification-reader PR #338 merged).

## What is established

The supplied diagnostic fails at its first dry run, before execution. It generates
SQL locally through `createOracleProviderDependencies` with a controlled query
transport, then submits that exact query with the installed BigQuery SDK. The
classification reader does **not** make an extra network call: its resolution is
part of warehouse SQL. Therefore neither `bound/invoked/attempted` nor a null query
ID identifies authentication, submission or warehouse planning as the cause.
Dry runs commonly return no executable job ID even on success.

Three independent production populations previously ran sequentially against one
45-second deadline. A slow first read could consume all later sources' budgets.
They now start concurrently (at most three), retaining the unchanged caller/request
deadline, warehouse timeout, byte bound and deterministic source outcome ordering.
Groups within each source remain sequential. Global cancellation still propagates.
Failure never becomes a successful empty population.

The diagnostic had a shared 90-second deadline and 15-second per-stage bounds.
Three dry runs alone consume at most 45 seconds, so **that shared deadline cannot
explain all three initial dry-run failures in the supplied report**. Its unbounded
submission continuation could, however, outlive its waiting timer without cancelling
a late allocation. Both cohort and classification diagnostics now use the shared
query lifecycle for dry runs, including late allocation cancellation. A cancellation
request/acknowledgement is not proof that warehouse work never started or stopped.

Each cohort diagnostic source now has its own 30-second total cap and unchanged
15-second stage caps. Authentication client/token preparation uses the same SDK
identity as submission. Timings separate local client construction, SQL generation,
authentication, submission, submission response and result retrieval. Only fixed
stage names, bounded milliseconds, SQL hash/size/CTE count and existing allowlisted
error fields are retained. No tokens, headers, provider bodies or customer IDs.

## Generated SQL and traversal inspection

The exact production factory generated 25,182 bytes for WW, 25,184 for USD and
25,612 for Shopify; each has 55 `AS (` CTE definitions. The shared resolver contributes
6,652 bytes and 19 CTE definitions. `cr_evidence` has five textual occurrences
including its definition. BigQuery can inline reused CTEs: these counts describe
query structure, not planning duration or an execution plan.

Traversal remains finite, nonrecursive and governed: current/supersession-resolved
approved identity edges in both directions, active reporting family member-to-parent
routes, and one identity edge followed by one family route. Current collections,
revocations, conflicts, core/named contradictions and parent-versus-variant handling
remain intact. WW and USD product/customer namespaces remain separate. No evidence
shows that traversal or query complexity caused this incident, so neither was
weakened or speculatively rewritten.

## Actual live attempts and remaining cause

The original command was attempted using the real SDK and configured runtime
identity. Request `6ae988ca-1e44-443c-8f7b-1c3eb509d423` returned HTTP 403 from
`oauth2.googleapis.com` for all sources. The managed environment's enforced outbound
policy excludes Google API and Render hosts. This is a different failure from the
reported Render deadlines; it cannot establish the original production root cause.

After instrumentation, separate WW/USD/Shopify checks again stopped at token
authentication (403). SQL generation took 2–4 ms; token attempts about 75–109 ms;
local SDK construction about 1 ms. No BigQuery submission event was recorded in
these instrumented attempts. Production classification resolution, dry-run latency
and execution latency remain unverified. No Render shell/tool is connected here.
The reported request has not been correlated to server or BigQuery audit logs.

## Exact bounded Render checks

Run these from a checkout of this PR in the existing Render runtime with its normal
reporting identity. Each command is independent; a failure must not gate the next.
They only dry-run and retrieve governed aggregates. No deployment is required or
authorized by this checklist.

```sh
timeout 40s node diagnostics/oracle-cohort-providers.js --as-of=2026-10-19T12:00:00Z --source=woo:ww --execute
timeout 40s node diagnostics/oracle-cohort-providers.js --as-of=2026-10-19T12:00:00Z --source=woo:usd --execute
timeout 40s node diagnostics/oracle-cohort-providers.js --as-of=2026-10-19T12:00:00Z --source=shopify:shopify --execute
```

After authentication succeeds, independently profile only the unchanged resolver
(no order population), then each source's classification-stage population. Both
validation and execution retain 15-second bounds and 20GB maximum bytes billed:

```sh
timeout 40s node diagnostics/oracle-classification-coverage.js --as-of=2026-10-19T12:00:00Z --stage=resolver --execute
timeout 40s node diagnostics/oracle-classification-coverage.js --as-of=2026-10-19T12:00:00Z --source=woo --store=ww --stage=stages --execute
timeout 40s node diagnostics/oracle-classification-coverage.js --as-of=2026-10-19T12:00:00Z --source=woo --store=usd --stage=stages --execute
timeout 40s node diagnostics/oracle-classification-coverage.js --as-of=2026-10-19T12:00:00Z --source=shopify --store=shopify --stage=stages --execute
```

Use timings and SQL hashes with Render logs and BigQuery audit logs around the
original request time. Submission without response means request outcome is unknown;
null job ID alone does not prove no request reached BigQuery. Resolver-only versus
population results distinguish shared classification work from source population
planning; neither alone proves causation. Keep the PR unmerged until that original
failure is explained and the bounded production checks succeed.

No collection, backfill, source mutation, deployment or merging was performed.
