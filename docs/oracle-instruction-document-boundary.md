# Oracle instruction, document and contextual intent boundary

## Demonstrated causes

The unchanged production email is preserved in `test/fixtures/delivery-messaging-email.txt`, including its example customer promises and final contextual reference to the Black Friday sale.

Both `analysis-context` and the historical-event recognizer combined a Black Friday name with words including “sale”, “last” and “years” to select an analytical route. Neither required a comparison/report instruction. The baseline dispatcher subsequently tried legacy subject recognizers, allowing supplied content to select execution independently of resolved scope. The UI/direct/durable entrypoints need a shared current-message authority boundary before retained scope, pending clarifications or any capability/provider dispatch.

Knowledge date resolution searched the whole message for the first relative expression. Proposal processing attached that resolution to every candidate and overwrote campaign dates with it. Thus a relative delivery promise could be presented as an implementation/event date. The code demonstrates the role error; it does not establish the production message receipt timestamp or explain the precise displayed October 13 value independently of that timestamp/model output.

Knowledge retrieval normalized BigQuery DATE instances but did not normalize TIMESTAMP instances or serialized timestamp field wrappers. Event provenance printed identifiers/provider names as ordinary Markdown. Shared rendering now handles literal identifiers and timestamp wrappers.

## Shared behavior

`message-intent` separates the user's action from supplied emails, labelled documents, quotations and fenced/quoted material. The current action controls precedence; the document remains available for synthesis/extraction. An unrequested pasted document produces one clarification. Explicit edit/context/knowledge actions cannot execute analytical subject recognizers. Explicit knowledge requests receive proposals for review rather than executing an analysis. Recognized analytical shorthand and compatible follow-up exclusions remain supported.

The boundary is enforced in shared context transitions, direct `/agent`, interactive/durable dispatch and baseline composition. Analytical event detection requires comparison/report intent, and exclusions/context do not activate the Black Friday comparison. Explicit “Compare the Black Friday campaigns described below” is preserved. A supplied document's generic text task reaches a tool-free model path in the direct server, while governed explicit subject analysis can execute its resolved binding.

The document itself cannot consume an old analytical clarification or supply a new report date/product/metric. Unrequested document input clears the active analytical scope; historical transcript messages are not changed. Analytical scope is inferred from the instruction outside the payload.

Knowledge extraction remains separate. Ordinary previously eligible assertion briefs still support proactive review proposals, explicit save requests support proposals, and the authenticated `/propose` ingestion workflow authorizes document extraction without analytical execution or saving. Example/customer-facing delivery promises are excluded from effective-date resolution. Their wording remains in the source/model extraction input. Undated documents produce undated records; single explicitly dated assertions and existing relative campaign briefs remain supported. A document's resolved time is not broadcast as a forced date across campaign candidates, and resolution metadata accompanies only matching event dates. These deterministic guards do not substitute for reviewing model proposals, especially documents with several independently dated assertions.

`event-presentation` is shared by historical-event, monthly promotion-context and general sales-context reports. The knowledge retrieval boundary normalizes stored temporal values across event/fact/definition/memory consumers.

## Proposal versus saved state and authorization audit

Proposal normalization marks records `persisted: false` and `approval_required: true`. Neither direct analysis nor model proposal generation has a knowledge write tool. `/knowledge/approve` and `/memory/approve` require an authenticated Oracle session, allowed origin, JSON content type and matching CSRF token. They validate the governed record, replace `created_by` with the session subject and await `writeRecord` before returning the ID. `writeRecord` awaits a BigQuery insert; approved linked updates may additionally supersede an existing record. No such live operation was performed in this task.

The browser's “Saved as” label follows the approval response, not proposal generation. It now validates a successful response with an ID, records saved state and renders the ID using a code element. Failed/malformed acknowledgements cannot mark a proposal saved.

This audit proves the code's write/authorization path, not persistence of the production records mentioned in the incident. No affected record IDs, approval responses or production audit logs were supplied. Runtime credential observations were unknown; no live knowledge query/mutation was performed. Production verification must inspect the exact IDs, stored `created_by`, source reference, recorded timestamp and approval audit evidence. Existing records were not deleted, modified or superseded.

## Verification and live limits

The new regression suite runs the unchanged email through production context and direct/shared dispatch in a fresh conversation and after Black Friday, shipping, product and conversion conversations, asserting zero analytical provider/model calls. It tests emails/documents/quotations containing analytical words, explicit document analysis, positive Black Friday comparisons, contextual event mentions/exclusions, quoted customer promises, true campaign timing, explicit knowledge requests and ingestion, timestamp wrappers and proposal/save acknowledgements.

Authenticated HTTP tests exercise interactive chat, lease-owned durable completion, persisted job results and polling. The browser-consumed result contract recovers the clarification from serialized results. Approval tests write only to an in-memory insert mock, never production knowledge. Editing/document synthesis tests use mocks; the tool-free OpenAI text path still needs a bounded live model check. Existing report and transport regressions cover shared analytical refinements, rendering and recovery.

Final full repository verification passed: 1,244 tests, zero failures and three opt-in live checks skipped (1,247 total). Focused acceptance/transport verification passed 82 tests; final routing/context verification passed 49 tests. Syntax and whitespace checks passed. Earlier full runs exposed overbroad exclusion, mixed analysis/save and quoted-product guards; these were corrected before final verification.

Live checks remaining: replay the exact email and explicit analysis/ingestion actions in the deployed authenticated browser after separately authorized deployment; verify no event/provider calls using correlated logs; inspect the affected saved-record IDs and approval evidence read-only; confirm real model proposal wording/uncertainty and tool-free text-task delivery. Local polling/result-contract checks do not establish deployed browser delivery. No collection, backfill, inventory calls, production source/knowledge mutation, schedule changes, deployment or merge was performed.
