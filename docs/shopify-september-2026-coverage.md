# Shopify September 2026 eligibility coverage

## Acceptance status

Full September platform acceptance is **pending**. The bounded GBP evidence covers
September 1–24, 2026, not the full calendar month. The currently evidenced eligible
population is **413 distinct fully joined orders / GBP 112,676.29**. It must not be
described as an accepted full-month Online Store order total.

The earlier rendered result of 4,130 orders / GBP 1,126,762.90 was exactly ten times
this population and is a rendering defect, not a source population. Separately, raw
string values declared as BigQuery `DATE` parameters returned zero rows. Typed
`BigQuery.date` parameters and independently embedded, validated date literals agree;
the diagnostic records the runtime parameter shape so prose cannot stand in for
binding evidence.

## Read-only population trace

For GBP financial orders dated September 1–24:

| Stage | Distinct orders | Net sales where established |
| --- | ---: | ---: |
| Financial source | 1,138 | diagnostic output |
| Location matched | 1,138 | diagnostic output |
| Customer matched / fully joined | 946 | GBP 262,168.29 |
| Customer unmatched | 192 | diagnostic output |
| Eligible after all predicates | 413 | GBP 112,676.29 |

Duplicate financial, location, and customer identity indicators were zero. Therefore
the inner customer join removes 192 of 1,138 financial orders (joined coverage
83.1283%) before eligibility can be decided. This is a customer-source coverage gap,
not evidence that those orders are ineligible.

Financial evidence authoritatively establishes order date, presentment currency,
original presentment total, and recorded presentment refunds. Location evidence
authoritatively establishes retail-location and source-app/channel exclusions.
Cancellation and financial-status eligibility genuinely require the customer row.
An absent customer row is therefore unknown eligibility: it is reported and excluded,
never silently dropped or treated as eligible. Current customer classifications must
not be substituted for the missing contemporaneous rows.

## Separate recovery recommendation

Do not recollect data, alter schedules, mutate production, or reset watermarks as part
of diagnosis. First export only the 192 bounded missing order identifiers and inspect
the customer collector/source window for September 1–24. After confirming the cause,
run a separately approved **customer-only** catch-up bounded to the confirmed missing
dates/order IDs. Then rerun the typed-parameter/literal-control diagnostic and the
country/platform validation. Acceptance requires 1,138/1,138 required-row coverage
or an explicitly reviewed residual population, zero duplicate identities, and a
separate reconciliation of the eligible result; 413 alone does not satisfy it.
