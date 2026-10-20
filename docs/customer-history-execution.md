# Woo → Shopify history execution package

Implementation: `customer-identity/history.js`, `history-sql.js`, and the shared
Oracle identity adapter. These commands are ready for the reviewed checkout;
**none of the write commands below was executed in this task**. No deployment or
activation was performed. The older Metorik diagnostic remains read-only.

The new mode includes guests as **email-linked records**, separately from
registered-customer identity. It never creates source customer IDs. A usable
address groups supported email records; equality is not proof of a person.
Unmatched registered histories keep their original source-local reference;
unmatched anonymous orders retain separate opaque order-record references.
All original transactions remain in the governed warehouse. Matrixify copies
are identity evidence only and stay excluded from purchases; genuine later
Shopify purchases count. Remapping precedes first-observed cohort assignment,
sequencing, first-to-second timing, repeat metrics and product/journey analysis.

## Source contracts and selection

* Roster: original `metorik_uk.orders`, `metorik_us.orders`, and Shopify
  `order_locations`, all retained original history through 2026-10-19 UTC, all statuses. The technical
  lower guard is 1900-01-01, not a business launch-date assertion; the older
  diagnostic’s 2022 start date does not truncate historical enrichment.
  Deduplicate by store/order. At most 60,000 original orders/source. No products,
  currencies, transaction eligibility, classification or original dates change.
* Retained native evidence: explicit existing `dataset.table`, original `order_id`
  (or native `id`) and root or `raw_json` fields. Exact order ID, UTC creation
  instant and currency must agree with the roster. Both root and raw email
  observations survive; disagreement is not silently resolved by precedence.
  The traced repository writer of `woocommerce_uk.orders_api` is native Woo's
  `syncWooUKOrders` / `transformWooUKOrder`, which serializes the full native
  response. Other discovered tables require explicit provenance verification;
  dataset names establish no origin.
* Native Woo: existing `WOO_UK_*` / `WOO_US_*` HTTPS REST v3 Basic authentication,
  exact original order lookups, explicit selected email/time/currency fields.
  Current guest status never erases a historical warehouse ID or historical
  email. Registered customer lookup uses only a positive native API ID agreeing
  with the original roster customer ID. Order 404 becomes unavailable evidence;
  transport/auth errors stop the batch and do not fabricate missing emails.
* Metorik: existing `METORIK_UK_API_KEY` / `METORIK_US_API_KEY`, production Bearer
  auth and store API URL. Fifty records/page; supported array/data/resource
  envelopes and pagination/meta/links metadata. Require correct page/per_page/
  has_more_pages, including an advancing nonempty nonterminal page. No guessed
  resource ID lookup, guest filter, date filter, or protected-field assumption.
  Orders must match canonical original order ID/date/currency. Customer records
  retain their positive Metorik ID including guests; they are not native Woo IDs.
  A customer email reaches an order only through an explicit Metorik customer
  relationship or a positive original Woo ID corroborated by a matching Metorik
  API order. Uncorroborated customer evidence remains stored and unresolved.
* Existing migration exports: `--adapter=migration --evidence-table=dataset.table`
  requires explicit `source_store` (`ww`/`usd`), `source_order_id`,
  `source_order_created_at`, `currency` and recognized email fields. The original
  source order/date/currency must match. Create no inferred crosswalk from order
  numbers, names or coincidentally equal customer IDs. An existing verified
  read-only view can expose these fields from a differently shaped retained export.
* Shopify: existing app/shop/token client, exact parent GIDs in batches of fifty;
  request order/customer email, actual attached/null customer, creation/update,
  financial status and cancellation. These additive observations also fill
  missing analytical relationships/status for the 865 parent gaps; no source-table
  recovery or watermark mutation is required. Existing source eligibility wins
  when present. Omitted customer/eligibility fields fail the batch, never a guest.

The current executor's repeated read-only source probe returned no Metorik payloads
and unavailable warehouse schemas. No live source availability or prevalence is
claimed. This access issue does not prevent shipping the actual collectors and
reader. Resolve executor access on the existing authorized production runner;
there is no additional code/logging merge required. Do not claim upstream absence.

## Storage, safety and resumability

All writes target the restricted identity dataset, never existing Woo/Shopify
orders, financials, line items, source customer tables, refresh state or schedules.
Existing provisioning/setup ACL, schema and region safeguards are reused.

`history_orders` holds one source/order roster record, preserving original IDs.
`email_observations` is additive, keyed by a deterministic observation digest over
source/record/order/profile/provider/field/value/source revision. Identical retries
deduplicate; later placeholders/nulls cannot delete an address. Different usable
revisions remain and participate in conflict checks. Provenance includes provider,
record ID, field path, native and Metorik IDs, source update and retrieval times.
Customer/registered profile address conflicts, multiple known profiles sharing
an address within a source, and order-level address conflicts exclude that address
globally. Guest emails are email records, not inferred registered profiles.

`history_progress` stores private cursors by source, adapter, window, evidence
table and revision. Each batch atomically MERGEs observations/roster and advances
its cursor, with a compare-and-swap assertion. A crash before commit repeats the
same batch; a crash after commit resumes after it. No email update overwrites
history. One executor at a time; concurrent cursor changes abort. A completed job
is a no-op on rerun. A new explicit `--revision` rescans without deleting evidence.
Metorik pagination is resumed by page: run against stable retired history; a
changing collection needs a fresh revision to rescan and reconcile before freezing.

Each invocation: ten-minute deadline, default five batches (explicit 1–1200),
256 MiB decoded upstream JSON, 2 MiB/response, no automatic API retries.
Native calls: at most 120,000; other adapters: 2,400 requests/invocation.
Metorik: at most 1,200 pages/resource/revision (60,000 records), failure on overflow.
Roster and retained batches: 100 rows; native/Shopify: 50 orders. Retained duplicate
order groups are never split at a cursor boundary; an oversized group stops.
Retained payloads over 2 MiB stop. Each warehouse read/write statement retains
1 GB billed-byte and 20 s job bounds; these are per-statement ceilings, not an
entire-run cost estimate. Each evidence stage has a one-hour expiry, private 0600
temporary NDJSON and finally cleanup. Original runtime deadlines, classification,
query cancellation/ownership and source-local fallback safeguards remain.

CLI output is compact aggregate JSON: source/adapter, completion state, batch and
record counts, HTTP byte/request counts; progress commands never print cursors.
No emails, source IDs, payloads, credentials or upstream error bodies enter logs.
Do not use shell tracing or commit exports. A safe failure category distinguishes
contract, bound, configuration and access/storage failures without provider text.

## One ordered production sequence

Use the existing protected credentials from the reviewed checkout. Initial reads:

```sh
export GOOGLE_PROJECT_ID=gf-full-data
for identity_source in ww usd shopify; do
  timeout --signal=TERM --kill-after=3s 45s node customer-identity/history.js plan --source="$identity_source"
done
timeout --signal=TERM --kill-after=3s 900s node diagnostics/metorik-email-evidence.js
```

Inspect source schemas, actual native/Metorik contracts and retained export lineage;
use the known WW table and any **verified existing** USD/raw/migration relation.
API denials are unavailable access, not redaction. Review counts and the following
bounded writes before execution; leave production identity mode source-local.

1. If absent, provision the restricted dataset using the existing provisioning
   command; otherwise inspect it and skip provisioning. Then add the schemas:

   ```sh
   timeout --signal=TERM --kill-after=3s 125s node customer-identity/cli.js provision --dataset=customer_identity --apply
   timeout --signal=TERM --kill-after=3s 125s node customer-identity/history.js setup --dataset=customer_identity --apply
   ```

2. Materialize all three bounded rosters. Repeat only a command returning
   `resumable`, inspecting each compact result; do not use an unbounded retry loop:

   ```sh
   for identity_source in ww usd shopify; do
     timeout --signal=TERM --kill-after=5s 650s node customer-identity/history.js collect --adapter=roster --source="$identity_source" --dataset=customer_identity --batches=600 --revision=history-20261020-v2 --apply
   done
   ```

3. Recover retained evidence first. WW's traced native table is ready to configure:

   ```sh
   timeout --signal=TERM --kill-after=5s 650s node customer-identity/history.js collect --adapter=retained --source=ww --evidence-table=woocommerce_uk.orders_api --batches=600 --revision=history-20261020-v2 --apply
   ```

   Use the identical command with `--source=usd` and the **verified** existing USD
   evidence relation when discovered; do not invent its name. For an existing
   migration relation matching the explicit contract above use `--adapter=migration`.
   Missing retained access does not authorize a new raw export or source rewrite.

4. Collect Metorik historical order and customer evidence and native order email
   evidence for both stores; preserve everything already retained. Run each once,
   then resume only unfinished commands after reviewing failures/progress:

   ```sh
   for identity_source in ww usd; do
     for identity_adapter in metorik_orders metorik_customers native; do
       timeout --signal=TERM --kill-after=5s 650s node customer-identity/history.js collect --source="$identity_source" --adapter="$identity_adapter" --batches=20 --revision=history-20261020-v2 --apply
     done
   done
   timeout --signal=TERM --kill-after=5s 650s node customer-identity/history.js collect --source=shopify --adapter=shopify --batches=300 --revision=history-20261020-v2 --apply
   ```

   A failed batch does not advance. Stop on access/correspondence/bound failures;
   do not blindly retry. A permanently unavailable supplemental adapter can remain
   partial if another order-evidence adapter completes for that store; report it.
   Publication requires complete canonical rosters, completed Shopify retrieval,
   one completed order-evidence adapter for each Woo store, and a positive actual
   cross-source match count. An unavailable order can still have retained email.

5. Review coverage and progress, then freeze only after review. Every original
   snapshot order falls into exactly matched, unmatched, ambiguous or unavailable;
   counts sum to each store's full all-status original-order denominator. Guests
   are reported separately. This includes imported Shopify evidence rows in the
   evidence denominator; they remain excluded from purchase calculations.

   ```sh
   timeout --signal=TERM --kill-after=3s 45s node customer-identity/history.js status
   timeout --signal=TERM --kill-after=3s 45s node customer-identity/history.js preview
   timeout --signal=TERM --kill-after=3s 60s node customer-identity/history.js publish --snapshot=history-20261020-v2 --revision=history-20261020-v2 --apply
   timeout --signal=TERM --kill-after=3s 60s node customer-identity/history.js check --snapshot=history-20261020-v2
   ```

   Publication uses one transaction, verifies current canonical roster membership
   and duplicates, and atomically stores immutable `identity_order_links` plus the
   existing readiness marker. The snapshot contains opaque references and coverage
   states, not emails. No publication if there are zero supported matches. A later
   refresh uses a new revision and snapshot name. Stop collection during freezing.
   `check` executes the ordinary shared Oracle summary path in process and rejects
   fallback; it does not alter the running server's settings or persist a job.

6. Deployment remains a separately approved operation. The prepared runtime settings
   for that operation are:

   ```text
   ORACLE_CUSTOMER_IDENTITY_MODE=email_candidate_v2
   ORACLE_CUSTOMER_IDENTITY_DATASET=customer_identity
   ORACLE_CUSTOMER_IDENTITY_SNAPSHOT=history-20261020-v2
   ```

   The existing result contract still calls analytical candidates
   `email_candidate_v1`; `version=order_email_v2` and explicit email-linked-record
   semantics distinguish the new order path. Direct, interactive, durable delivery
   and recovery retain snapshot/coverage metadata. Recovered results do not reread
   or relink. An unavailable snapshot/coverage query falls back visibly. Disable
   the mode to roll back; no source or evidence deletion is required.

A match establishes supported observed linkage, **not** complete follow-up or a
verified person. Mature retention continues to require independent collection
coverage; linked histories do not inherit source-local completeness certificates.
Observed subsequent purchases and first-observed history are usable immediately
after approved collection/publication and runtime configuration. Rates that require
unverified maturity remain unavailable, rather than replacing observed history
with a blanket assertion that all linkage is unverified.
