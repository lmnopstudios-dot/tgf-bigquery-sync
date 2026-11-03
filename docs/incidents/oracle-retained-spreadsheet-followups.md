# Shared spreadsheet follow-ups

## Behavior

After a successful Oracle report, ask “can I have this as a spreadsheet,”
“export that,” “Excel please” or “download these results.” The shared dispatcher
uses compatible, owner/session-scoped retained structured evidence. It does not
invoke a provider, refresh quantities, discover new products or collect data.

Format-only turns change only presentation preferences. Product selections,
locations and workshop exclusions, date/cutoff scope, filters, ordering and
analytical plan remain intact. Explicit refresh or scope-changing wording is
not consumed as a format-only turn.

The download is a persisted, authenticated XLSX, not a rendered Markdown table.
Inventory uses one row per variant and separate available-quantity columns for
locations. Zero, negative and unavailable values remain distinct. Other reports
retain source fields and order, with nested product/cohort tables carrying
parent labels and denominators. Existing basket, campaign, weekday and
order-value workbook contracts remain in use. No rate, currency conversion or
cross-location total is invented.

Source notes (Definitions in existing report workbooks) retain original source
observation timestamps, requested scope, coverage limitations and the original
answer. Incomplete/truncated evidence is labelled; an export does not make it
complete. Unsupported personal/secret fields, absent tabular evidence, expired
retained results, incompatible scope, Excel bounds or the existing 8 MB storage
ceiling produce a specific limitation with no provider fallback or truncation.
Validated direct callers retain evidence for 15 minutes per owner; UI callers
use their session cache and pass it into durable jobs. Clearing the analysis
prevents fallback to a different direct-caller cache. A persisted export can
still be downloaded/recovered independently of the short-lived evidence cache.

## Alphabones incident

The supplied conversation is preserved verbatim in the HTTP regression:

> Show current available stock for Alphabones, broken down by every variant and size, at Kings Cross, Shoreditch, Soho and Online Ready to Ship.  Exclude workshops. Show one row per variant and one column per location. Keep zero stock distinct from unavailable quantities.

> can i have this as a spreadsheet

The supplied answer repeated the table, changed observation timestamps and ended
“XLSX: failed. No persisted workbook download is available.” At pre-fix main
`3823178`, local scope resolution set `output_preference=xlsx` while leaving
`stock_scope.format=table`. The stock path therefore did not create the requested
artifact. The component-outcome label alone does not establish storage failure,
and no such cause is assumed. Exact production log evidence was unavailable.
The new shared path intercepts the format-only turn before the provider binding;
it exports the preceding evidence, preserving its original times.

## Validation and rollout

`test/retained-spreadsheet.test.js` covers the exact multi-turn request through
interactive and durable HTTP, XLSX cells, timestamps, zero/negative/unknown
quantities, partial labels, sales currencies, nested customer denominators,
provider-call counts, scope preservation, owner authentication, artifact
integrity, missing/expired evidence, session clearing and failed-job recovery.
The central gate also exercises existing report-specific workbook/download
contracts. Browser coverage is registered for desktop and mobile in
`test/helpers/retained-spreadsheet-browser.js`.

Run:

```sh
npm run test:oracle:acceptance
npm run test:oracle:browser
```

The acceptance gate passed with 990 passed, nine skipped. The browser gate could
not launch because Chromium is not installed; an earlier download attempt failed.
Provider responses are fixtures. Deployed chat delivery remains unverified.
No Shopify/warehouse provider reads, inventory changes or report replay were
performed to implement this patch. Keep draft until the browser gate and the
normal deployed delivery checks can run; no broad diagnostic or recollection
is required to test a formatting-only follow-up.
