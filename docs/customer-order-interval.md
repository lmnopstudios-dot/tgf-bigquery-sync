# Governed customer order interval

Oracle answers “What is the average time between online orders for the same
customer?” with `get_average_customer_order_interval`. The production acceptance
exchange is:

> **User:** What is the average time between online orders for the same customer?
>
> **Oracle:** What date range would you like?
>
> **User:** last 3 years

On 24 September 2026 the executed inclusive period must be **24 September 2023
through 24 September 2026**. Oracle must execute once rather than repeat the
clarification, must not mention or default a currency, and must return the
customer count, order-pair count, average days, and approximate median days.

## Definition

The later order in a consecutive pair must fall in the inclusive requested
period. Its immediately preceding eligible order may predate the start boundary;
this avoids incorrectly treating the first in-period order as the customer's
first observed order. Only identified customers with at least one pair
contribute. Customers with one eligible order and guest/unresolved identities do
not contribute.

Eligible orders are completed or processing Woo online orders and paid,
partially paid, or partially refunded non-cancelled Shopify online orders.
Matrixify-imported Shopify orders are excluded. Woo WW, Woo USD, and Shopify
customer IDs are source-qualified and remain separate; no cross-platform person
bridge is inferred. The query returns aggregates only and never emits customer
or order identifiers.
