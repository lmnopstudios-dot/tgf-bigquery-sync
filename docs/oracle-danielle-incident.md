# Danielle stock-clearance incident and production acceptance

## Diagnosis

The `product_affinity` primary and guest BigQuery jobs both completed. They were not the terminal failure. The next agent round still had to submit their function outputs to the Responses API and obtain a final answer. The UI-to-agent request shared the same 90-second edge as the agent deadline, so a slow continuation could be aborted by the UI fetch before the agent returned a bounded response. That transport exception reached the UI router's outer catch and became the generic “The request could not be completed” message. Proposal generation happens after chat and is already optional; it cannot explain a log line emitted by the outer chat failure path.

The affinity call was unnecessary. “Use data where possible” in a broad clearance advisory did not ask which customers or products overlap. The model over-selected a generally available behavioural tool and matched an unrelated `TGF Chunky Hoop Earring (Single)` seed. Affinity is now admitted only for explicit affinity, customer-overlap, also-bought, bought-together or cross-sell intent, is limited to one call, and all evidence calls are capped at six.

## Safe production acceptance sequence

1. Deploy to a non-production revision and confirm startup succeeds.
2. Send the Danielle brief with a safe `X-Request-Id` and confirm the response header echoes it.
3. Confirm logs contain `request_id`, `stage`, `outcome`, `elapsed_ms`, and (only on failure) `error_class`; confirm they contain no SQL, parameter values, customer names, bearer tokens, or prompt payloads.
4. Confirm the brief does not call product affinity. Then send an explicit “also bought/customer overlap” request and confirm at most one affinity call and at most six total evidence calls.
5. Inject a final-synthesis timeout after both affinity jobs complete. Confirm a partial advisory returns within 95 seconds, includes verified-source labels and proposed clearance tactics, and does not expose the provider error.
6. Inject catalogue, inventory, affinity, and proposal failures independently. Confirm successful evidence and useful advice remain, unavailable evidence is labelled, and each durable claim produces no more than one proposal card.
7. Run `npm test`, inspect the staged revision logs, then shift production traffic gradually while monitoring terminal stage/error-class counts by request ID.
