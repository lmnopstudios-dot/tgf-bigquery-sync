# TW supplier stock report

In authenticated Oracle chat, type **TW supplier stock report** or **TW supplier
stock report for October 2026**. The default is today in London. The workbook
includes 12 completed months and, where applicable, the cutoff month-to-date.
Historical requests never use live inventory.

## Evidence and planning inputs

- Shopify Admin: current product tag exactly `tw`, case-insensitive, all
  statuses and every retained variant; current active location **available**
  units, with workshop and non-workshop pools separate. Missing quantities
  stay blank. No inventory mutations.
- BigQuery: deduplicated Shopify finance, source locations and line items.
  Match by full Shopify variant ID. Successful native Online Store and POS
  orders remain separate; known imports and cancellations are excluded.
  Coverage shows missing line joins, unattributed/invalid lines, sales lines
  outside the current tagged population, and other/unknown order sources.
- Product returns, historical stock, receipts, stockout days and sell-through
  have no verified variant/location binding in this report. Their cells remain
  blank. Order recommendations do not impute demand lost to stockouts.
- The workbook uses observed sale-date windows, not discount attribution.
  The historical event registry records the known May and November windows
  and their participating channels. Historical uplift is provisional:
  observed event units less the ordinary daily baseline for the same channels.
  Only apply reviewed future dates and explicit variant participation.
- Backfill is separate from this read-only report. The report checks order-to-
  line coverage even inside reviewed windows; positive observed sales can still
  be shown when a period is incomplete. No zero or forecast is inferred from
  warehouse absence alone.

Optional private runtime JSON in `ORACLE_TW_SUPPLIER_SETTINGS`:

| Key | Contract |
| --- | --- |
| `verifiedWindows` | Array of reviewed source-complete London dates, with `start`, exclusive `end`, and `channels` containing `Online Store` and/or `POS`. These are evidence declarations, not report filters. Certify only after reconciling sales and line ingestion against the source. |
| `sellableLocationIds` | Reviewed native Shopify location GIDs usable for the supplier stock pool. No assumed retail/warehouse allocation. Workshops are never usable. |
| `futureEvents` | Reviewed `name` (`Black Friday` or `May Bank Holiday`), `start` and exclusive `end` in London calendar dates. |
| `mayPlan` | Reviewed `requiredShelfDate` and optional `receivingBufferDays`. Shelf date must be no later than the sale start when known. |
| `variants` | Map by exact variant GID. Optional `packSize`, `participates`, dated `confirmedInbound` entries (`dueDate`, `units`) with `inboundReviewedOn`, and `confirmedBackordersNotInAvailable` with `backordersReviewedOn`. Supply reviews must match the cutoff. Use an empty inbound list or explicit zero backorders only when confirmed. |

The supplier lead time is always three **calendar** months. For an order dated
10 November, arrival is 10 February and ordinary cover runs through 9 March.
The pre-delivery projection applies confirmed receipts on their due dates and
floors stock at zero; forecast shortfalls don't roll into the buy. The buy
covers one calendar month of ordinary demand from arrival, less projected remaining stock and
confirmed receipts due during that cover, plus only confirmed customer
backorders not already reflected in available stock. Check whether receipts
due after arrival land soon enough. Unknown dated inbound is not deducted;
unknown customer backorders are not added. Legacy day-based lead time and
undated inbound aggregates are no longer used.

The May top-up is separate from the current buy. The order deadline works
backward from the shelf date, subtracting any known receiving buffer before
the three-month supplier lead time. Without a confirmed shelf date the
deadline stays blank. Uplift is provisional and requires a reviewed event,
participation and comparable historical sales. No schedule or supplier action
is added.

## As-of ordering

Use `TW supplier stock report` for today, or `TW supplier stock report as of
10 November 2026` (ISO dates also work). The completed-month form ends at that
month's London month-end. Sales stop at the selected cutoff; today's sales
are partial and do not enter the run rate. The coverage tab distinguishes
latest reconciled completed day, trailing gaps and verified days.

Today's report uses the uniquely resolved Kings Cross, Shoreditch, Soho and
Online Ready to Ship locations, or the reviewed location-ID setting if the
names cannot be resolved. Workshop stock is excluded. Available units already
exclude commitments. Earlier cutoffs run a catalogue-only read. A verified
same-date stock snapshot may be supplied by a provider, but no historical
stock source is currently wired in production.

The provisional baseline uses identifiable ordinary sales over reconciled
completed observation days, requiring at least 80% per channel in each of
the last three completed months. Completed current-month ordinary days can
also contribute. Unresolved lines are disclosed and excluded from variant
units. Unverified absence never establishes zero demand. Black Friday and
post-sale units are reported separately; May uplift is a separate planning line and never changes the ordinary buy.

## Trial buy and Read me

The Trial buy tab is a review queue, never part of the ordinary buy. It
screens variants without an ordinary recommendation using the last six
calendar months of observed Online Store and POS units. At least two
identified units and known pooled stock are required. Variants with stock
remaining must show a risk of running out before delivery based on their
observed ordinary sales pace; promotional spikes do not drive that pace.
Same-day partial sales do not count. Trial quantities are capped at three
and reduced by projected remaining stock and confirmed dated inbound in
the cover period. Verify inbound and supplier pack sizes before placing a PO.
The first workbook tab explains the evidence and the difference between a
blank quantity and a calculated zero.
