# Oracle conversational analysis state

Oracle keeps a bounded analytical context in an in-process server map keyed by a hash of the authenticated eight-hour UI session token. It expires on process restart, session expiry, logout, or **Clear analysis**. It is not Knowledge, Memory, browser storage, or durable customer data.

The whitelist is defined in `oracle/analysis-context.js`. Raw responses, SQL, reasoning, secrets, and PII are not accepted. Each message produces a validated transition (`continuation`, changed/cleared/retained field names, missing fields, and readiness). Unrelated Knowledge questions do not receive analytical constraints. Report v2 supplies its structured handoff separately, which initializes current/comparison periods, section, currencies, and recognized metrics.

Diagnostics log field names and safe readiness metadata, never raw filter values or tool output. The production validator is an isolated non-writing state-machine harness and does not call production data services.
