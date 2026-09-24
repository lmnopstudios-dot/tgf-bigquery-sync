# Danielle stock-clearance incident and production acceptance

## Diagnosis

The `product_affinity` primary and guest BigQuery jobs both completed. They were not the terminal failure. The next agent round still had to submit their function outputs to the Responses API and obtain a final answer. The UI-to-agent request shared the same 90-second edge as the agent deadline, so a slow continuation could be aborted by the UI fetch before the agent returned a bounded response. That transport exception reached the UI router's outer catch and became the generic “The request could not be completed” message. Proposal generation happens after chat and is already optional; it cannot explain a log line emitted by the outer chat failure path.

The affinity call was unnecessary. “Use data where possible” in a broad clearance advisory did not ask which customers or products overlap. The model over-selected a generally available behavioural tool and matched an unrelated `TGF Chunky Hoop Earring (Single)` seed. Affinity remains admitted only for explicit affinity, customer-overlap, also-bought, bought-together or cross-sell intent. The durable job has no blanket tool-count cap: it is bounded by per-call cancellation, the model's round guard and the eight-minute overall job runtime, allowing the complete batched 20-item analysis.

## Safe production acceptance sequence

1. Deploy to a non-production revision and confirm startup succeeds.
2. Send the full 20-item Danielle email. Confirm `POST /api/oracle/jobs` returns `202` and a job ID promptly, then refresh the page and confirm the same job continues.
3. Confirm logs contain `request_id`, `stage`, `outcome`, `elapsed_ms`, and (only on failure) `error_class`; confirm they contain no SQL, parameter values, customer names, bearer tokens, or prompt payloads.
4. Confirm the brief does not call product affinity and that catalogue, exact-location inventory, sales comparison and final synthesis cover all 20 requested items without invented figures.
5. Let synthesis run beyond 74 seconds, refresh again, and confirm one complete answer is returned. In a separate job press Cancel and confirm it becomes `cancelled`.
6. Inject catalogue, inventory, affinity, and proposal failures independently. Confirm successful evidence and useful advice remain, unavailable evidence is labelled, and each durable claim produces no more than one proposal card.
7. Restart the staged Render service with one queued job and one deliberately running job: queued work must resume, while the expired running lease must become safely failed (never silently replayed). Run `npm test`, inspect only request/stage/outcome/error-class metadata in logs, then shift traffic gradually.
