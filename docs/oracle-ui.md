# Oracle UI v1

Oracle UI is a dependency-light server-rendered shell with vanilla JavaScript and CSS, served by the existing Node/Express service at `/oracle/`. It adds no frontend service and keeps browser-session chat in the page only. The navigation reserves a disabled Reports entry for the future Report v2; no report UI is implemented.

## Authentication and browser security

Set `ORACLE_UI_PASSWORD`, a random `ORACLE_UI_SESSION_SECRET` of at least 32 characters, and optionally `ORACLE_UI_ADMIN_NAME`. Login exchanges the password for an eight-hour, HMAC-signed, `HttpOnly`, `SameSite=Strict` session cookie. Production cookies are also `Secure`. A separate random double-submit CSRF cookie/header plus exact-origin checking protects every state-changing authenticated route. JSON writes require `application/json` and all JSON bodies are limited to 48 KiB. Google, OpenAI, sync and service-account credentials remain server-side.

This is deliberately a single shared internal administrator login, not a user-management system. Rotate the password/session secret in Render to revoke every session. Set `ORACLE_UI_ORIGIN` only when the externally visible origin differs from the request host.

## API contracts

All routes below use the `/api/oracle` prefix. Reads require a valid session; mutations additionally require CSRF and origin validation.

* `POST /auth/login` accepts `{password}`; `POST /auth/logout` expires the session; `GET /session` checks it.
* Oracle has one **Send** action. A bounded local classifier sends short questions, conversational follow-ups, knowledge proposals, hypothetical rules and definitions to `POST /chat`; substantial multi-item analytical briefs go directly to `POST /jobs` before any analysis tool runs. The classifier makes no model, Shopify, or other network call. `GET /jobs/:id` is the refresh-safe status/result read and `POST /jobs/:id/cancel` explicitly cancels queued or running work. Ownership is bound to the signed browser session, not a caller-supplied user field.
* For deep analysis only, the UI stores the active opaque job ID in browser storage, polls for safe states (`queued`, `running`, `completed`, `failed`, `cancelled`), and restores polling after refresh. The complete durable answer, inline chart, and knowledge proposals use the same renderers as chat. Prompts, SQL, parameters, model output, customer data, and raw tool results are never progress events.
* `POST /propose` creates zero or more validated, non-persistent knowledge/memory candidates from a natural-language message.
* `POST /knowledge/approve` and `POST /memory/approve` accept only `{kind, proposal, proposal_id?}`. They revalidate against the existing governed schemas and call the existing administrative writer. There is no table, SQL, dataset or generic write parameter.
* `GET /knowledge` and `GET /memory` support `text`, `status`, date and tag filters plus `kind` or `memory_type`. `GET /knowledge/:id` and `GET /memory/:id` return exact records.

Proposal generation is a separate bounded OpenAI Responses call using the strict `propose_governed_records` function schema. Its only input is the current message, a bounded set of duplicate candidates, and safe evidence references; it has no analytical tools or write capability. The response may contain up to 12 facts, events, definitions, or memories. Every candidate is independently normalized and passed through the governed validators before the UI labels it saveable. Exact content duplicates are labelled already known, and exact title matches may suggest an opaque supersession target; neither operation mutates data.

Explicit “remember” wording strengthens intent but never writes. Questions return an empty list. Uncertain statements become working hypotheses or are omitted. Confirmed memories require governed evidence. Users can select, edit, discard, save individually, or save selected; every Save remains a separate authenticated/CSRF-protected administrative request and is revalidated server-side. Invalid model candidates are non-saveable until edited. `ORACLE_PROPOSAL_MODEL` optionally selects the proposal model and defaults to `gpt-5.6`; no dataset or schema change is required.

A deliberately narrow preflight skips proposal context lookup and the secondary model request for obvious pure questions, comparisons, and analytical commands. Ambiguous, declarative, persistence-directed, and mixed assertion/question messages continue to the model. The model is forced to make one strict `propose_governed_records` Responses API function call; an empty `proposals` array is successful. The strict schema uses the API-supported `anyOf` union rather than `oneOf` and disables parallel tool calls.

After deployment, run `npm run validate:oracle-proposals-production` first. It uses synthetic question, assertion, and multi-record campaign fixtures with the configured proposal model. It imports no writer and invokes no approval endpoint, so it cannot persist a proposal. Failure logs identify the operation, phase, model, error class, HTTP status, and provider code/type where available without logging payloads, credentials, raw responses, or stack traces.

## Deployment

No build step or dataset seed is required. Configure the three variables above on the existing Render web service and deploy the committed revision using the existing start command:

```sh
npm start
```

Open `https://<existing-render-service>/oracle/`. Existing production knowledge—including Black Friday records—is queried from BigQuery and is not copied or seeded by this feature.

## Durable worker deployment

The existing Render web service is also the queue worker; no ephemeral disk or additional Redis service is used. Durable jobs are enabled only with `ORACLE_ANALYSIS_JOBS_ENABLED=true`; ordinary `/chat` remains independent. At startup the enabled worker validates or creates `commerce.oracle_analysis_jobs_v1` in the existing BigQuery project, so the Render service account needs BigQuery dataset/table create, query-job creation, table read and table update permissions. Enqueue is query DML rather than the streaming insert API: the committed row can therefore be claimed and updated immediately without waiting for a streaming buffer. Keep one Render instance unless/until the queue claim transaction has been production-validated for multi-instance deployment. Set `ORACLE_JOB_RUNTIME_MS` only to lower the default eight-minute overall bound; production should leave it unset. Individual model and tool calls inherit the job abort signal and the seven-minute agent deadline, leaving a minute for terminal persistence.

After readiness passes, run the write-path lifecycle smoke only from Render Shell with `ORACLE_JOB_QUEUE_SMOKE=true npm run smoke:oracle-job-queue`. It is not a startup hook. It uses the existing configured table and one marked synthetic, non-customer row, without invoking analysis or exposing payloads/credentials.

Queued jobs survive a Render restart in BigQuery and are claimed when the new worker starts. A process can die after a non-transactional external call, so an expired `running` lease is deliberately marked `failed` with the safe `WORKER_RESTARTED` reason rather than replayed and risking duplicate execution. The user can retry explicitly. Completed answers remain durable and may be read after refresh; polling never executes a job. Cancel sets durable cancellation state and aborts the local running controller.

Errors returned to browsers are allow-listed validation messages or generic failures. Raw BigQuery errors and stack traces are not serialized. Logging passes errors through central credential redaction, including Google `Authorization: Bearer` values, token fields, client secrets and private keys.

## Proposal intent and response rendering

The proposal model semantically decomposes realistic documents into a compact set of durable records and preserves material campaign windows, channel/store timing, offers, exclusions, and stated provenance. It returns no proposals for questions, comparisons, analytical requests, or casual chat. Deterministic code remains authoritative for schema, date, status, provenance, length, tag, PII-key, evidence, duplicate, and supersession validation. The analytical agent remains read-only, and model output never reaches BigQuery without an explicit approval request.

Oracle answers are rendered by the local DOM-based Markdown renderer. It creates an allowlisted set of elements for headings, paragraphs, emphasis, lists, tables, code, and safe links without `innerHTML`. Raw HTML remains text, link protocols are restricted to HTTP, HTTPS, and mailto, and numeric entities are converted to text before DOM construction.

The chat view is a viewport-bounded flex layout in which the conversation thread—not each message—is the vertical scroll container. Messages and proposal cards grow to their full content height, while wide Markdown tables and code blocks scroll horizontally. The composer remains at the bottom of the view. New content follows the bottom only when the reader was already within 120 pixels of it, so a reader who scrolls upward is not pulled away from older content.

Manual layout acceptance: send several short messages, then receive one very long response, a response with a wide/large table, and several proposal cards. Verify that the complete thread scrolls vertically; ordinary messages and proposals have no vertical scrollbar; tables/code can scroll horizontally; the composer stays accessible on desktop and mobile; content follows when already near the bottom; and new responses do not move a reader who intentionally scrolled upward.
