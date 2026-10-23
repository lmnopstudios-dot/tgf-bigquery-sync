# Woo review after verified UI provenance

The supplied production read verified `gf-full-data.commerce`, the END. positive control and both retained-result parser controls. All 24 inspected Woo parent references have no persisted decisions or consumed routes. This is a scoped finding, not a claim about every possible historical variation. Square decisions must remain Square decisions.

## Historical source-key finding

**Still unverified whether the historical actions selected the wrong source.** The supplied terminal summary omits the 12 saved operation records and decision provenance. A source-key conversion bug has not been demonstrated. The saved file contains the evidence needed to distinguish an operation submitted with a Woo reference from one submitted with a Square reference. No new warehouse query is needed.

The UI queue source filter is sent as `source`; returned rows display their source label. Select/preview captures the row product, and family assignment posts that product as `source`. Bulk review posts each selected row’s `source_product_ref`; the service records that exact `source_ref` in submitted and terminal operation events, looks up the exact product and persists the same source key. Identity creation posts the selected left/right products. No inspected path translates Woo keys to Square keys.

A separate display defect exists in the manual create-mapping picker: result labels and selected-product copy say Shopify even when the unrestricted search returns Woo or Square. The underlying payload keeps the actual reference. This is a possible source of confusion, not established historical attribution. The queue-specific choose/family picker restricts its target search to Shopify and retains its source anchor. Do not rewrite historical decisions on this basis.

Receipt interpretation: compare each operation’s submitted and terminal `source_ref`, `shopify_parent_ref`, `row_request_id`, `decision_event_id` with the actual decision endpoints. Woo submitted → Square persisted under the same event ID demonstrates a persistence discrepancy. Square submitted → Square persisted establishes a Square operation, but does not establish what the reviewer intended. Missing receipts leave click-level history unverified; single-action endpoints need not produce bulk receipts.

Known separate Square relationships: Old Warpig Ring identity approval `78f56b81c09f67e03ec32bb90c86d273`; Powerslave family `081fb233b91591a7c8d47e64253917ee`; Ace of Spades family `689dcd2373f66cacf02ba28aae323042`; Warpig Ring family `ce27425efc0de9e78d96bc8521ae1052`. Their existence does not authorize any Woo relationship.

## Exact Woo relationships for human review

Source evidence: successful retained Woo discovery jobs `a68390f8-1438-4581-ab4b-8c88233a293b` (WW) and `cf5bdbdf-15b0-4ce1-b08d-f112861bfe32` (USD), plus the supplied actual-UI provenance output. Reuse these results; do not execute them again. Titles identify human review leads only.

Prioritized by **eligible recorded orders**, because distinct affected customer counts are not present in this retained discovery extract. Do not substitute order counts for customer counts. Targets below are historical title-based review leads only, not proven identities. User confirmation establishes that the four Iron Maiden products were listed in both Woo stores; recorded sales are separate evidence. Review the source catalogue/order evidence and target specification in Product Mapping / Product Families before deciding identity versus family membership. No approval is requested for the existing Square relationships.

| Woo source reference | Historical title | Eligible / recorded orders | Shopify review lead (product ID) | Required action / conflict |
|---|---|---:|---|---|
| `woo:ww:11549` | Old Motörhead Warpig Ring | 89 / 91 | 10434364408135 | Verify equivalence; review identity or reporting-family assignment separately |
| `woo:ww:11593` | Motörhead 'Warpig' Ring | 70 / 71 | 10434363883847 | Verify equivalence; review identity or reporting-family assignment separately |
| `woo:ww:11737` | Iron Maiden 'Powerslave Eddie' Ring | 54 / 56 | 10434361590087 | Verify equivalence; review identity or reporting-family assignment separately |
| `woo:ww:92837` | Motörhead 'Warpig' Pendant | 33 / 33 | 10434341667143 | Verify equivalence; review identity or reporting-family assignment separately |
| `woo:ww:11594` | Motörhead 'Ace of Spades' Ring | 29 / 29 | 10434363818311 | Verify equivalence; review identity or reporting-family assignment separately; Square Ace family points to 10434353791303, conflicting with lead 10434363818311—resolve specification first |
| `woo:ww:11795` | Iron Maiden 'Piece Of Mind Eddie' Ring | 25 / 26 | 10434361459015 | Verify equivalence; review identity or reporting-family assignment separately |
| `woo:ww:23150` | Iron Maiden ‘Killers Eddie’ Ring | 19 / 19 | 10434361327943 | Verify equivalence; review identity or reporting-family assignment separately |
| `woo:usd:106807` | Motörhead 'Warpig' Ring | 14 / 14 | 10434363883847 | Verify equivalence; review identity or reporting-family assignment separately |
| `woo:ww:44905` | Iron Maiden 'Book of Souls Eddie' Ring | 14 / 14 | 10434361164103 | Verify equivalence; review identity or reporting-family assignment separately |
| `woo:usd:106986` | Old Motörhead Warpig Ring | 10 / 10 | 10434364408135 | Verify equivalence; review identity or reporting-family assignment separately |
| `woo:usd:106800` | Motörhead 'Ace of Spades' Ring | 9 / 10 | 10434363818311 | Verify equivalence; review identity or reporting-family assignment separately; Square Ace family points to 10434353791303, conflicting with lead 10434363818311—resolve specification first |
| `woo:usd:106354` | Iron Maiden ‘Killers Eddie’ Ring | 7 / 7 | 10434361327943 | Verify equivalence; review identity or reporting-family assignment separately |
| `woo:usd:106592` | Iron Maiden 'Piece Of Mind Eddie' Ring | 7 / 7 | 10434361459015 | Verify equivalence; review identity or reporting-family assignment separately |
| `woo:usd:106660` | Iron Maiden 'Powerslave Eddie' Ring | 4 / 4 | 10434361590087 | Verify equivalence; review identity or reporting-family assignment separately |
| `woo:usd:108048` | Motörhead 'Warpig' Pendant | 4 / 4 | 10434341667143 | Verify equivalence; review identity or reporting-family assignment separately |
| `woo:ww:11634` | Old Motörhead Warpig Pendant | 3 / 3 | 10434341863751 | Verify equivalence; review identity or reporting-family assignment separately |
| `woo:ww:80797` | Large / Medium / Motörhead x TGF 'Ace of Spades' Anniversary T-shirt / Motörhead x TGF 'Ace of Spades' Anniversary T-shirt - Small / Small / X-Large | 3 / 5 | Unestablished | Identify target from non-title product evidence before proposing a relationship |
| `woo:usd:106178` | Iron Maiden 'Book of Souls Eddie' Ring | 1 / 1 | 10434361164103 | Verify equivalence; review identity or reporting-family assignment separately |
| `woo:usd:108303` | Old Motörhead Warpig Pendant | 1 / 1 | 10434341863751 | Verify equivalence; review identity or reporting-family assignment separately |
| `woo:usd:108052` | Motörhead x TGF 'Ace of Spades' Anniversary Pendant | 0 / 0 | Unestablished | Identify target from non-title product evidence before proposing a relationship; listed/discovered, no eligible sales in retained records (not proof of no sales) |
| `woo:usd:108175` | Motörhead 'Bomber' Anniversary Pendant | 0 / 0 | Unestablished | Identify target from non-title product evidence before proposing a relationship; listed/discovered, no eligible sales in retained records (not proof of no sales) |
| `woo:usd:108623` | Large / Medium / Motörhead x TGF 'Ace of Spades' Anniversary T-shirt / Small / X-Large | 0 / 0 | Unestablished | Identify target from non-title product evidence before proposing a relationship; listed/discovered, no eligible sales in retained records (not proof of no sales) |
| `woo:ww:60637` | Motörhead 'Bomber' Anniversary Pendant | 0 / 0 | Unestablished | Identify target from non-title product evidence before proposing a relationship; listed/discovered, no eligible sales in retained records (not proof of no sales) |
| `woo:ww:80795` | Motörhead x TGF 'Ace of Spades' Anniversary Pendant | 0 / 0 | Unestablished | Identify target from non-title product evidence before proposing a relationship; listed/discovered, no eligible sales in retained records (not proof of no sales) |

No new Woo decision, collection, report replay, snapshot change or production write was performed. The successful report and accepted SQL remain unchanged. Follow-up coverage certification remains separate from these attribution gaps.

## Inspect only the already-saved receipts

Run from the existing Render shell. This reads one local evidence file, prints compact receipt/decision provenance and does not import BigQuery, execute SQL or change the evidence file. It preserves the existing record history and emits no reviewer names or notes.

```bash
timeout --signal=TERM --kill-after=2s 10s node diagnostics/read-saved-ui-operation-receipts.js
```

Use the script from this PR checkout, or the self-contained inline equivalent below (works on the deployed checkout without fetching source):

```bash
timeout --signal=TERM --kill-after=2s 10s node --input-type=module <<'JS'
import {readFileSync,statSync} from 'node:fs';
const file='/tmp/oracle-ui-product-routes-383.json';
if(statSync(file).size>16777216)throw Error('Evidence file bound exceeded');
const evidence=JSON.parse(readFileSync(file,'utf8'));
const fields=['operation_id','row_index','row_request_id','request_id','action','source_ref','shopify_parent_ref','status','decision_event_id','decision_id','event_id','left_ref','right_ref','relationship_id','supersedes_decision_id','replacement_for_decision_id','provenance','recorded_at','reviewed_at'];
const checks=(evidence.checks||[]).filter(c=>/^ui_persisted_(operation|outcome|identity|family)$/.test(c.check));
if(checks.length!==4)throw Error('Expected four saved persisted-evidence checks');
const output=checks.map(c=>{
 if(c.status!=='read_completed'||!Array.isArray(c.rows))return {check:c.check,status:c.status,job_id:c.job_id,unavailable:true};
 if(c.rows.length>502)throw Error('Saved result bound exceeded');
 const inventory=c.rows.find(r=>r.kind==='inventory');
 const records=c.rows.filter(r=>r.kind==='record').map(r=>{
  const raw=typeof r.record==='string'?JSON.parse(r.record):r.record;
  return Object.fromEntries(fields.filter(k=>raw[k]!==undefined).map(k=>[k,raw[k]]));
 });
 return {check:c.check,job_id:c.job_id,inventory:inventory?.record,records};
});
console.log(JSON.stringify({read_only:true,queries_submitted:0,evidence_file:file,checks:output}));
JS
```
