# Optional Square and cross-channel customer reports

This adds `square_channels_v1`, an optional reporting scope over the existing
`email_candidate_v2` snapshot, with the separate identity extension
`square_native_email_v1`. It supports collaboration retention, overall
second-purchase products, and collaboration-entry next-purchase products.
Existing requests, accepted SQL/report contracts, saved evidence and historical
validation artifacts retain their legacy behavior when `journey_scope` is null.
No collector, mapping decision, source data, active snapshot or ready marker is
changed. No identity publication or activation is performed by this change.

## Reused production evidence

The supplied successful #400 Render output is preserved as aggregate-only evidence
in `test/fixtures/square-reporting-400-evidence.json`. All preview stages compiled
and executed, with the existing snapshot guard passing:

- 1,543 native Square IDs / 2,050 orders had snapshot email candidates.
- 1,524 IDs / 2,026 orders survived both-side transaction eligibility.
- 47,814 Square orders remained outside the linked subset, including anonymous
  orders; 15,515 identifiable native Square IDs retained source-local histories.
- Square → Shopify: 548 email-candidate records / 732 destination orders;
  Square → WW: 476 / 728; Square → USD: 29 / 40.
- Shopify → Square: 53 / 53; WW → Square: 839 / 1,082;
  USD → Square: 40 / 48. Directions/platforms overlap and cannot be added as people.

Those counts are observed preview evidence, not newly executed report counts,
representative retail samples, verified people, first-ever acquisition or a
coverage certificate. No directory discovery, coverage recovery, ring-sizer,
monthly-sales or collaboration diagnostic is replayed.

## Independent channel roles and chronology

The validated context field is:

```json
{
  "version": "square_channels_v1",
  "include_square": true,
  "entry": "instore",
  "followup": "all",
  "next": "anywhere_then_filter"
}
```

Entry/follow-up each accept `all`, `online`, or `instore`. `include_square` is
independent: the all-channels population can include Woo WW/USD online, Shopify
online/POS and eligible Square customer transactions when Square is explicitly
requested and reviewed. Square exclusions and unknown channels are reported.

Eligible linked histories and unmatched native customer histories are combined
**before** `ranked_orders` assigns first-observed purchases and order sequence.
Unknown channels also participate in that history. The entry-date/channel filter
is applied to the existing first-observed order. It cannot turn a later online
purchase into acquisition merely because a customer's earlier purchase was in
store, outside the entry window, or had unknown channel provenance.

The follow-up rule is explicit:

- `anywhere_then_filter`: select the next strictly later eligible order anywhere,
  then require its channel to match. An intervening online purchase prevents that
  customer satisfying “next purchase anywhere, if in-store.”
- `next_matching_channel`: select the next strictly later eligible order matching
  the follow-up channel. An intervening online purchase may be skipped for “next
  in-store purchase.” This is labelled selected follow-up, not necessarily the
  customer's second order overall.

Equal timestamps never establish a subsequent purchase. Orders retain native
source namespaces and timestamps; platform order and publication time do not
establish chronology. Both filters and the selection rule appear in the answer,
provider definition, versioned report contract and persisted analytical plan.
Scope mutation is rejected on delivery, authenticated polling and recovery.

## Identity, transaction and attribution safeguards

The extension reuses #400's successful adapters and exclusions: latest Square
orders; exact untrimmed native order/customer IDs; payment fallback only if
unambiguous and consistent with the order; exact new-directory profile joins;
conservative usable-email normalization; global shared/conflicting-email and
snapshot-native-cardinality exclusions. It never matches names or publishes
raw addresses or customer references. Unsafe bridges retain native Square-local
identities, allowing repeat purchases within Square without asserting an online
identity. Anonymous/conflicting-native-ID Square orders are counted in coverage
and **excluded from customer-cohort denominators**, rather than inventing a new
customer for each order. Existing online guest/snapshot semantics are unchanged.

Original Woo source/order keys count once. Shopify Matrixify copies, cancelled,
unsupported-status and fully refunded/zero-net-total orders retain existing
exclusions. Square retains the established COMPLETE/COMPLETED native status rule;
this extension does not infer a new Square finance/refund ledger. Other
undocumented imports and residual cross-platform duplicate originals remain
unverified and are disclosed. The linked subset is not representative of all
retail customers.

Woo has its existing online provenance. In the new reporting version Shopify
retail-location evidence supports in-store; persisted `Online Store`/`Shop`
provenance supports online; insufficient evidence stays `Unknown`. Square
in-store requires completed card-present EMV/SWIPED/CONTACTLESS payment evidence
at the exact order location, without contradictory completed-payment/location
evidence. A location ID, keyed card, cash payment or an inferred location name
alone does not establish physical in-store provenance. Other Square orders stay
unknown, without being silently relabelled online. Unknowns remain in full-history
sequencing and satisfy neither online-only nor in-store-only entry/return filters.

Square line items are reconciled by exact order, offset, UID, native product ID
and quantity against the latest order payload. Duplicate retail-view revisions
cannot multiply lines. Unreconciled/non-positive-quantity lines remain unknown
attribution. Existing approved product identities, current reviewed reporting
families and historical classification evidence are reused. Ambiguous approved
routes are marked conflicting; titles label products but do not establish Square
collaboration/Ring-Sizer membership or merge identities. Named entry excludes
generic-only, unnamed, conflicting and unidentified membership. Unmapped source
products can remain separately labelled `unmapped_item` in downstream products.

Coverage includes source/year/channel transaction orders, customer-history
orders, excluded unidentifiable/conflicting-ID Square orders, analytical records,
missing lines, approved mapping lines, ambiguous lines and governed named lines.
Product shares retain every returning customer in their denominator, including
unknown attribution. Customers may appear across product/cohort breakdowns;
counts must not be summed as unique people.

Continuous verified rates require independent certificates covering **all four**
participating sources, including Square, in the same time zone/common interval.
An online-only follow-up filter cannot make an absent Square certificate valid.
Without that evidence, verified rates remain unavailable and provisional observed
and age-qualified rates stay separate. Activity endpoints never certify history,
first-ever purchase or complete follow-up.

## Review and activation boundary

The controls are opt-in and default off. `Include Square` is disabled until the
separate-role controls are enabled. New-question clears the opt-in. Conversation
can express/refine the same roles; changing analytical subject clears them.
Neither UI nor conversation can approve, publish or activate the extension.

Normal Square-inclusive report execution requires both explicitly configured
`ORACLE_SQUARE_REPORTING_VERSION=square_channels_v1` and an extension ID in
`ORACLE_SQUARE_REPORTING_EXTENSION_ID`. The ID must match exactly one independently
reviewed row in `<identity dataset>.identity_reporting_extensions`, with fields
`extension_id`, `state='reviewed'`, `reporting_version='square_channels_v1'`,
`identity_version='square_native_email_v1'`, and `base_snapshot` equal to the active
accepted snapshot. The query checks this guard as well as the unchanged base
snapshot guard. Missing configuration, marker/table, mismatch or failed reads
fail closed; an apparently complete legacy population is never substituted.

This PR intentionally contains **no schema setup, marker publication, identity
publisher or environment activation operation**. The new marker is a future
review/deployment prerequisite, not permission to create it now. The implementation
uses a dynamic read-only analytical overlay; it does not append Square rows to
the published three-source `identity_order_links` or change its source whitelist.
A replacement snapshot is neither necessary nor created. Raw source/profile
revisions can change observed candidates; they are always revalidated by the
versioned rules, without claiming an immutable new identity publication.

## One bounded Render acceptance command

From a checkout containing this PR, using existing Render credentials and the
existing v2 snapshot settings, run once:

```bash
timeout --signal=TERM --kill-after=3s 270s node diagnostics/square-reporting-acceptance.js
```

It executes the three actual generated report shapes in an explicit diagnostic
preview mode; it does not set activation variables or create a review marker.
Cases cover all-channel collaboration retention, in-store introduction with
follow-up anywhere, and online collaboration introduction followed by the next
in-store purchase. Local regressions cover the other direction/selection variants.
Output is aggregate-only, with per-stage compilation/execution/error metadata and
independent case outcomes. No customers, emails or order-level records are printed.

The **shared total execution ceiling is 5,000,000,000 bytes** across all stages and
cases, not 5 GB per report. Each data statement's cap is the remaining allowance;
authoritative billed-byte metadata is reconciled before further data statements.
Unknown allocation/accounting stops execution. Common compiled/executed source
relations are reused in session-local tables across reports. Every new SELECT has
a free dry run and estimate when supported; unsupported session dry runs are
explicit, and bounded execution must establish compilation. There is no claim
that a script dry run validates its entire graph. Limits: 60 seconds per data job,
240 seconds orchestration, 270 seconds outer shell, 300 SDK submissions, 1,000
aggregate rows per result. No automatic data-job retry or report replay.

Session cleanup is attempted on all paths. Temporary storage is separately
metered until cleanup or automatic expiry; this is a query execution byte ceiling,
not an all-in monetary/slot-reservation ceiling. Only temporary session relations
are created; accepted reports, mappings, snapshots and persistent warehouse
relations are untouched. The preview intentionally does not certify continuous
coverage. Review its actual customer denominators, unknown channels, mapping
coverage, exclusions and report limits before deciding on publication/activation.

## Regression and validation scope

New tests cover scope parsing/validation, source-first sequencing, both next-order
rules, native unmatched histories, excluded anonymous Square orders, unknown
channels, missing/ambiguous mappings, imports, timestamp ties, verified versus
provisional rates, missing activation, partial failures, cached-stage billing,
direct/interactive/durable delivery, canonical JSON persistence, authenticated
polling and no-replay refresh. Desktop/mobile browser regressions exercise actual
controls and visible scope/denominators. Existing accepted report artifacts and
SQL hashes remain preserved.

`test/square-channel-sql.py` additionally executes the actual generated SQL with
synthetic source/snapshot/governance inputs through SQLGlot/DuckDB. It documents
local dialect substitutions (JSON fallback, offsets, COUNTIF null semantics,
non-binding fixture array quotas and struct expansion). This is supplemental
local SQL execution, not BigQuery compilation or production verification. Its
JS tests explicitly skip if those optional Python packages are absent; the local
validation here installs them in `/tmp` and runs them with `PYTHONPATH` configured.
Stored HTTP/browser fixture results come from that synthetic SQL, never from
customer records or reconstructed production order data. The #400 supplied
aggregate evidence is separate from all synthetic report counts.

Local verification: all **917 Oracle acceptance tests passed**, with zero skips;
the desktop/mobile browser gate passed, including the new controls and durable
refresh recovery. The supplemental generated-SQL cases ran with DuckDB/SQLGlot
available. The bounded acceptance runner's four tests also passed after its final
SQL-hash/error-location instrumentation change. These results are local fixture
validation; the newly generated report queries still require the Render warehouse
acceptance command above. No production report execution, publication, activation,
merge or deployment was performed here.

### Follow-up: SDK calendar binding correction

The supplied Render execution of the original diagnostic compiled successfully
but returned empty coverage and incorrectly accepted zero cohorts. Its explicit
DATE types were paired with plain strings; the installed SDK omitted their scalar
values. The normal report provider already uses date wrappers and is unchanged.
The diagnostic now reuses that helper, proves the installed SDK's DATE encoding
locally, checks materialized native Square history before cohort work, and rejects
missing full-history coverage while still permitting genuine empty filtered cohorts.
See [the incident and corrected acceptance boundary](incidents/square-acceptance-empty-population.md).
The same command and shared 5 GB cap apply; the extra aggregate checkpoint is
charged from that allowance and reused across cases. The prior zero results are
invalid for reporting and do not establish absent customers or absent email.
