# Order-value production scope follow-up

Render confirmation supplied by the service owner identifies the deployed revision
as `16d6202b86aadd7690e3af9f65a7712b9d207034` (PR #319 merge). A fresh fetch
of `origin/main` resolves to that revision and contains `5834416`. This branch
starts there in an isolated worktree, leaving the original checkout intact.
Independent production HTTP access remains unavailable (`EAI_AGAIN`).

## Verbatim original request and demonstrated rejection

The complete request beginning “Assess our UK online free-shipping threshold.” was
recovered from the connected chat history and saved without adding a source name or
simplifying any clause in `test/fixtures/uk-shipping-original.txt`. Only the copied
“You”/“Oracle” transcript wrappers are omitted. Its escaped Markdown bullet markers
are retained. The previous `FULL` fixture is a condensed acceptance case, not this
verbatim request.

The original says **“Exclude non-UK and POS orders.”** Both order-value and weekday
scope parsers recognized a POS exclusion only when POS immediately followed
“Exclude”, “Excluding” or “Without”. The intervening non-UK list item caused POS to
be treated as affirmative. The original therefore resolved to `channel: null`
and hit the pre-provider population guard. The initial #320 combined-channel
preservation made that incompatible scope explicit as `channel_breakdown: true`;
it did not fix the negated list. All four original-prompt tests failed before the
shared qualifier fix, including the assertion that channel resolves to online.

The shared channel qualifier now ignores channel mentions in exclusion clauses,
including lists, while preserving affirmative mentions after a contrast such as
“Exclude returns, but include POS orders”. Both analytical scope parsers use it.
The complete original resolves GB shipping destination, online channel, GBP,
2026-01-01 through 2026-10-12, the existing band/scenario operation and the governed
order-value route. Population retrieval executes through the production factory.

The original source defects are reproduced locally. The production request's
persisted context and provider trace remain unread; no live financial results or
production browser acceptance are claimed.

## Other retained shared changes

An unspecified platform and channel can execute the disclosed Shopify online
subset. `answerOrderValues` binds the provider to online independently of the
submitted request plan. Strict evidence validation retains submitted scope while
hydrating the source store to Shopify. Presentation and recovery disclose
Shopify-only collected history and candidate-online eligibility; unspecified scope
remains partial. No population SQL or monetary calculation changes.

Explicit in-store, Woo, Square and pooled multi-source populations remain blocked.
Combined online/in-store scope survives chart/export refinements. A prohibition on
pooling does not add a pooling requirement.

## Regression paths

The **unchanged original** runs through shared context/dispatcher, direct HTTP
agent bridging, authenticated interactive/latest recovery, and lease-owned durable
persistence with authenticated repeated polling. Tests use actual production
provider factories, baseline composition, dispatcher and population SQL bindings;
only external BigQuery, Shopify and knowledge I/O use controlled fixtures.

Assertions require GB/online/GBP resolution, completed-day dates, actual population
attempts, both bounded aggregate queries, unchanged eligibility predicates,
scenario calculations, promotion and add-on sections, and recovery without more
population reads. The input contains no Shopify qualifier. Cross-subject tests
cover listed POS exclusions and affirmative POS requests for weekday and
order-value analysis. Explicit unsupported scopes remain blocked.

The initial change passed 1,205 repository tests (three opt-in live checks skipped)
and validated 46 strict tool schemas across 61 tools. Follow-up results are recorded
in the PR description and task report.

No collection, backfill, source/knowledge mutation, deployment or merge is performed.
