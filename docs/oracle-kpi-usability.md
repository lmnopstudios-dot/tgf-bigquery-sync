# KPI scrolling and data readiness

## What went wrong

The application locks document scrolling and gives each full-height view its own
scroll container. The KPI section inherited `.view { overflow:hidden }` but did
not opt into a vertical scroller. A successful long report therefore extended
outside the visible area without a reachable lower section.

The KPI section now owns vertical scrolling, contains horizontal overflow, and
keeps its header and result root from flex-shrinking. The section is a labelled,
keyboard-focusable region. Desktop/mobile browser tests require PageDown to
move it and the final coverage section to be reachable.

## What the unavailable values mean

Unavailable is not zero and does not mean the Shopify orders are missing.

| Item | Reason / presentation |
| --- | --- |
| Conversion | The exact governed converted-session numerator is not connected. Purchases per session is not substituted. |
| Turnover | Compatible merchandise/tax/refund-occurrence measures remain unbound. Gross AOV is not relabelled turnover. |
| Verified new / returning | Earlier cross-platform purchasing history is incomplete. First observed is not necessarily new. |
| Current MTD | Its completed-day range may extend beyond the last source-reconciled day. Collection or a successful query does not extend that certification. |
| Fixed baseline | The first verified three-month proposal exists, but no fixed baseline has been configured. Its values can be shown as proposed references without applying a fixed target or inventing approval. |

Supported cards are now shown first. Unsupported requested measures remain in
an explicit data-readiness section with reasons and next actions, rather than
repeated empty cards for both selected period and MTD. When no MTD values are
supported, one explanation replaces the empty card grid; all missing measures
remain available in details and the workbook.

The existing customer diagnostics are surfaced as clearly labelled observations:
known earlier-order customers, first-observed customers and customerless orders.
For example, 201 known earlier-order customers out of 960 identifiable customers
is a 20.9% **minimum observed share**, not a complete returning-customer rate.
The 759 first-observed customers are not labelled verified new. Counts are shown
only when their interval is reconciled and classification totals agree with the
distinct customer denominator. Customerless orders do not enter that denominator.

New reports include reviewed source intervals, the latest fully reconciled
London day and the number of completed calendar days after it. This metadata
is derived only from existing reviewed certificates. It does not approve,
collect, reconcile or backfill anything. London DST and partial-day intervals
remain explicit. Older saved reports retain their existing statuses and say
when detailed cutoff metadata was not recorded; the UI does not invent it.

## Rollout and validation

The existing saved job can be reopened after an authorised deployment to use
the improved layout without repeating source reads. A new explicit report run
adds the detailed cutoff metadata to that new report and its Definitions and
coverage worksheet. Legacy workbook validation and owner-bound recovery remain
supported. No new run is automatically submitted.

Run the acceptance gate and desktop/mobile browser gate. Added scenarios cover
supported/pending grouping, proposed versus fixed baseline values, observed
customer bounds, a one-day MTD reconciliation gap, DST, partial days, combined
channel completeness and legacy reports/workbooks. Browser tests assert real
keyboard scrolling, bottom-of-view reachability and no page-width overflow.

This change does not connect the outstanding conversion/turnover/history
sources, activate a baseline, expand a coverage certificate, deploy, collect
source data or change a schedule. Use the existing read-only source audit and
review process before extending reconciliation coverage.
