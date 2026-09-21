# Oracle UI v1

Oracle UI is a dependency-light server-rendered shell with vanilla JavaScript and CSS, served by the existing Node/Express service at `/oracle/`. It adds no frontend service and keeps browser-session chat in the page only. The navigation reserves a disabled Reports entry for the future Report v2; no report UI is implemented.

## Authentication and browser security

Set `ORACLE_UI_PASSWORD`, a random `ORACLE_UI_SESSION_SECRET` of at least 32 characters, and optionally `ORACLE_UI_ADMIN_NAME`. Login exchanges the password for an eight-hour, HMAC-signed, `HttpOnly`, `SameSite=Strict` session cookie. Production cookies are also `Secure`. A separate random double-submit CSRF cookie/header plus exact-origin checking protects every state-changing authenticated route. JSON writes require `application/json` and all JSON bodies are limited to 48 KiB. Google, OpenAI, sync and service-account credentials remain server-side.

This is deliberately a single shared internal administrator login, not a user-management system. Rotate the password/session secret in Render to revoke every session. Set `ORACLE_UI_ORIGIN` only when the externally visible origin differs from the request host.

## API contracts

All routes below use the `/api/oracle` prefix. Reads require a valid session; mutations additionally require CSRF and origin validation.

* `POST /auth/login` accepts `{password}`; `POST /auth/logout` expires the session; `GET /session` checks it.
* `POST /chat` accepts `{message}` and returns `{answer, proposal}`. The server calls the existing protected `/agent` implementation internally with `SYNC_SECRET`; the browser never sees that secret or tool protocol.
* `POST /propose` creates a validated, non-persistent knowledge/memory candidate from a natural-language message.
* `POST /knowledge/approve` and `POST /memory/approve` accept only `{kind, proposal, proposal_id?}`. They revalidate against the existing governed schemas and call the existing administrative writer. There is no table, SQL, dataset or generic write parameter.
* `GET /knowledge` and `GET /memory` support `text`, `status`, date and tag filters plus `kind` or `memory_type`. `GET /knowledge/:id` and `GET /memory/:id` return exact records.

Chat proposals carry only a message hash/timestamp reference and authenticated creator, not the transcript. Explicit “remember” wording and selected durable statements can produce proposal cards, but never writes. Uncertain language is `working`. Findings without governed tool evidence are downgraded to working hypotheses. Users can edit allowed business fields, discard locally, or explicitly Save. Supersession uses the same Save path with an opaque `supersedes` ID; the writer requires a same-table existing, non-superseded target and keeps both records.

## Deployment

No build step or dataset seed is required. Configure the three variables above on the existing Render web service and deploy the committed revision using the existing start command:

```sh
npm start
```

Open `https://<existing-render-service>/oracle/`. Existing production knowledge—including Black Friday records—is queried from BigQuery and is not copied or seeded by this feature.

Errors returned to browsers are allow-listed validation messages or generic failures. Raw BigQuery errors and stack traces are not serialized. Logging passes errors through central credential redaction, including Google `Authorization: Bearer` values, token fields, client secrets and private keys.
