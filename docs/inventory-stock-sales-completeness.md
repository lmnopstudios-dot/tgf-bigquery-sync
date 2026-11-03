# Inventory and sales completeness

A multipart catalogue request previously returned early from stock scope resolution,
losing its sales requirement. Inventory sorting accepted only total POS Available.
The filtered inventory config now retains a sales requirement and accepts either
POS total or online Available sorting. The plan records the requested sales metrics.

The existing inventory export binding does not execute exact variant/location sales.
The separate `get_shopify_product_performance` implementation in `server.js` groups
by parent product, filters Online Store and caps results at 50. Those results cannot
be joined to every retained Shopify variant or used to infer refunded units by POS
location. This change explicitly reports these components as unsupported. It does
not implement a new sales source, infer zero sales, or combine currencies.

Each of units sold, refunded units and net sales has an unsupported component
outcome for online, Kings Cross, Shoreditch, Soho, other POS and unknown channels.
Inventory evidence and workbook remain available. The shared delivery contract
marks the response partial, including owner-authenticated saved-export manifests
and failed-job recovery. No provider call is used to repair presentation.

## Validation boundary

`test/oracle-inventory-sales-completeness.test.js` uses a synthetic extension of the
existing five-variant fixture. It checks shared parsing/planning, sorting, missing
sales disclosures, interactive/durable chat, authenticated workbook download,
manifest and delivery failure recovery. Browser coverage checks visible disclosure
and reload without provider replay. These are local fixtures, not deployed validation.

The production export
`abf857468192764b4ea46dfe4c47a6e8798c4bb3bc422eebd71de22e420cb62e`
and its original multipart request have not been recovered in this environment.
Google OAuth is blocked by the environment's egress policy (`Domain forbidden`).
No production inventory reads, selection, report replay or production changes were
performed. The exact 106 IDs, observations, timestamps and original request remain
unverified. Do not substitute the existing fixture: its thresholds are reversed
relative to this incident.

The user has been given a single Render-shell recovery command. Its only data
query is a parameterized SELECT on the exact artifact ID **and** the configured
chat owner's HMAC key, matching `oracle/ui-router.js` and
`oracle/product-priority-storage.js`. It reads dataset metadata for location,
writes the unmodified artifact and saved request into a mode-0600 JSON file inside
a mode-0700 temporary directory, and prints only path, byte length and checksum.
It does not call the export-store initializer (which can create a table), artifact
validation (which evaluates selection), workbook generation or Shopify.

Recovery is pending private transfer of that JSON from Render. After recovery,
inspect its exact saved request and preserve it verbatim as the incident regression.
Validate against the retained variant IDs and observations without inventory reads
or selection reevaluation. Do not mark this incident fixed based on fixture tests.
