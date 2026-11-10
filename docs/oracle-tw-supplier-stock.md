# TW supplier stock report

In authenticated Oracle chat, type **TW supplier stock report** or **TW supplier
stock report for October 2026**. The default is the last completed London
calendar month. A workbook includes the 12 months ending in that month and a
separate current month-to-date through yesterday. A historical month selection
does not turn live inventory into a historical snapshot.

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
| `variants` | Map by exact variant GID. Optional `leadDays`, `packSize`, `participates` (event-name array) and `confirmedInboundDueInTime` paired with `inboundReviewedOn` and `inboundHorizonEnd`. Inbound must be reviewed on the run date for that horizon. |

Unknown lead time gives a three-month baseline. Unknown inbound is not
deducted and is flagged. Unverified demand or usable stock withholds the
recommendation. Review gaps before placing a purchase order. No schedule or
supplier action is added.
