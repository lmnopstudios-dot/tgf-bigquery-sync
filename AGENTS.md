# Repository engineering guidance

Oracle changes (including server composition, providers and browser code) must
pass `npm run test:oracle:acceptance` and `npm run test:oracle:browser` before
release. See `docs/oracle-stabilisation.md` and the persistent matrix at
`test/fixtures/oracle-acceptance-matrix.json` for extension instructions and
bounded deployed acceptance. Local fixture success does not verify production.

Generic date clarification must not be emitted before shared scope resolution
and capability checks. Fix the owning shared mechanism, identify its callers,
and add related cross-subject and multi-turn regressions; supplied production
questions are acceptance cases, not the entire specification. Preserve each
provider's identity, date, attribution, grain and evidence semantics.
