# Reviewed large-roster pilot

Collection and reporting remain off. Existing configurations and the original
10,000-row limit are unchanged. No new profile is selected automatically.

## Cause and design

The first pilot hit the row cap before membership promotion. The old path
assembled the entire roster into one JSON query parameter, also limited to
4 MB. Raising only the row count would encounter payload, page or time bounds.
The opt-in staged path normalizes at most 500 customers, writes one bounded
JSON page to a run-specific table, and discards the page. Source IDs remain
in a bounded set to reject duplicates across pages. Cursor completion is
mandatory; no partial roster is certified.

At publication a transaction checks guard ownership, row count and distinct
customer IDs, then inserts the snapshot and complete coverage together. A
previous complete roster is not replaced or deleted. Points run only after
membership promotion, using the unchanged reviewed 1–5 November 2026 window.
Points retain their original row/page and 4 MB limits; failure preserves a
committed roster. No scheduler or balance mutations are introduced.

## Proposed explicit profile, requiring separate private review

Add a private roster_staging object only after reviewing this plan, with
reviewed_by and reviewed_at (the actual review timestamp). Do not change
config.limits or the public stub.

| Field | Proposed ceiling |
| --- | ---: |
| max_rows | 100000 customers |
| max_pages | 250 customer pages |
| max_calls | 300 shared vendor attempts, including access, retries and points |
| max_ms | 900000 shared vendor-client milliseconds, including staging waits |
| page_bytes | 2000000 normalized JSON bytes |
| max_bytes | 64000000 total normalized roster bytes |
| page size | 500 |
| rate/retries | Existing reviewed 4 requests/second and at most 2 retries |
| response body | Hard 8000000 bytes per response |
| warehouse stage/promotion query | 20 seconds, at most 1 GB billed bytes |
| staging expiry | 24 hours |

100000 customers need up to 200 full pages. Page allowance never overrides
row/call/time bounds. Limits cannot increase automatically. After the last
page, promotion and guard release have separately bounded warehouse calls;
these can exceed the vendor-client deadline. Do not externally kill an apply
run during uncertain publication.

## Rollout after code checks and private profile approval

Keep public configuration unverified and both permanent feature flags false.
Preserve private configuration in a secret-file mechanism; /tmp is ephemeral.
Never publish its identifiers or credentials.

The complete bounded preview command (all roster pages, aggregate output only,
no BigQuery access, stage writes or checkpoints) is:

    LOYALTYLION_CONFIG_PATH=/tmp/tgf-loyaltylion-reviewed.json \
    LOYALTYLION_COLLECTION_ENABLED=false LOYALTYLION_REPORTING_ENABLED=false \
    timeout --signal=TERM --kill-after=3s 16m node loyaltylion/sync.js --preview

Preview checks identity/site and exact ID syntax, not full purchasing linkage.
Record counts and bytes. If it fails, review strategy and bounds; no partial
roster can be called complete. Preview retains no customer data.

After a separately approved write, verify guard ownership, terminal prior jobs
and no active collectors. The gated apply command is:

    LOYALTYLION_CONFIG_PATH=/tmp/tgf-loyaltylion-reviewed.json \
    LOYALTYLION_COLLECTION_ENABLED=true LOYALTYLION_REPORTING_ENABLED=false \
    node loyaltylion/sync.js --apply

Heartbeats every 15 seconds and page completions show phase, pages, rows,
elapsed time, vendor calls and bytes. Only safe codes and allowlisted BigQuery
reasons appear in failures, never raw records, API messages or credentials.

## Failure and recovery

Page/stage/duplicate/normalization failures before publication cannot write
live membership or a complete marker. Private run-specific stages expire in
24 hours. Never manually promote a partial stage. A staging insert's uncertain
result is not a live membership commit.

If publication was submitted and its outcome is unknown, retain the guard.
Inspect terminal job status and the run's coverage_windows entry before
releasing ownership or permitting a fresh run. Never take over an old guard
automatically. A reviewed retry after a clean failure starts a new roster;
there is no cursor resumption or automatic replay. Earlier complete snapshots
and successful independent resources remain available.

Permanent table and partition expiry guards run before collection and before
publication; staging expiry is explicit and separate from dataset defaults.
