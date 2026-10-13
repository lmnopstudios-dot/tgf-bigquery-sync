# Order-value unspecified-scope follow-up

Render confirmation supplied by the service owner identifies the deployed revision
as `16d6202b86aadd7690e3af9f65a7712b9d207034` (PR #319 merge). A fresh fetch
of `origin/main` resolves to that revision; `git merge-base --is-ancestor 5834416
origin/main` succeeds. The new branch starts there in an isolated worktree, leaving
the original checkout intact. A separate HTTP root revision read remains unavailable
from this executor (`EAI_AGAIN`); the Render confirmation is the deployment evidence.

## Demonstrated defect

On the deployed source, `resolveExecutionPlan` accepts `platform: null` but rejects
`channel: null`. A submitted order-value context with country GB, currency GBP,
valid numeric operations/dates and neither explicit platform nor channel therefore
returns the reported population-only sentence before invoking the dispatcher
binding or population provider. The new regression fails against the deployed guard
and succeeds after the change. The existing #319 unspecified-platform tests always
supply `channel: online`, leaving this combination untested.

The shared planner now permits the supported Shopify online subset when channel is
unspecified and no channel comparison is requested. `answerOrderValues` binds the
existing provider to `channel: online`, independently of the submitted request plan.
The submitted platform/channel remain in the validated plan, while the source store
is hydrated to Shopify through the existing resolution contract. Presentation and
recovery disclose Shopify-only collected history and candidate-online eligibility;
the result remains partial for unspecified scope. No population SQL or monetary
calculation changed.

Explicit in-store, Woo, Square and pooled multi-source populations remain blocked.
Combined online/in-store scope carries `channel_breakdown`, which survives chart
and export refinements instead of disappearing into an unspecified null channel.
An explicit pooling requirement is retained as an unsupported population filter;
a prohibition on pooling does not add that requirement.

## Trace and verification limits

The regression uses the repository's full multipart acceptance fixture unchanged,
with submitted platform/channel varied at the validated-context boundary. It runs
`executeGovernedAgentAnalysis` and `dispatchAnalysisRequest`, the actual production
provider factory, baseline composition and dispatcher, real population SQL bindings,
HTTP agent bridge, lease-owned checkpoint/completion and shared recovery. External
BigQuery, Shopify and knowledge I/O use controlled fixtures. Assertions require the
population attempt and two bounded aggregate queries, check scope/dates/calculations,
and verify recovered prose/charts without repeated population reads. Existing
interactive/latest recovery and durable authenticated polling tests also run.

This fixture is **not established as the verbatim original production prompt**.
That prompt and the current incident request/job IDs were requested but were not
available while preparing this change. No correlated production context was read.
Consequently the unspecified-channel defect is demonstrated, but attribution of the
owner's particular production rejection and production acceptance remain unverified.
Do not interpret the fixture checks as live provider or browser verification.

No collection, backfill, source/knowledge mutation, deployment or merge is performed.

## Executed checks

- Deployed-guard reproduction: one failing unspecified-channel regression and one
  passing explicit-online control; reproduced pre-retrieval rejection.
- Focused conversation suites: 60 passed, zero failed.
- Final new-scope/unsupported/HTTP/persistence regressions: seven passed, zero failed.
- Full `npm test`: 1,205 passed, zero failed, three opt-in live checks skipped
  (1,208 total). Final stricter recovered-scope assertions also passed separately.
- Tool contracts: 46 strict schemas across 61 registered tools validated.
- Changed JavaScript syntax and `git diff --check` passed.
