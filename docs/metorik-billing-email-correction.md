# Metorik billing-email correction and agreement check

## Operator update, 2026-10-22

The live sample passed for five registered and five guest orders: exact original
ID, UTC creation timestamp, currency and usable normalized billing-email agreement.
All ten display order numbers differed; that cause remains unresolved. This direct
order evidence requires no customer-profile linkage and does not establish
population-wide coverage. A subsequent aggregate verified 50 usable persisted
billing_address_email observations with order provenance. The operator now reports
WW history-20261021-billing-v3 complete and every required v2 collection complete.
Do not rerun the historical diagnostic or collection proposal below. Publication
continues to use v2 completion assertions while consuming additive observations
across revisions; see the [release plan](customer-history-coverage-release.md).

The sections below retain the original pre-collection proposal and evidence state.

The documented Metorik order email path is `billing_address_email`:
[official order contract](https://metorik.dev/#orders). The old five-path extractor
omitted it. The supplied Render sample verified usable native and Metorik order
email in one registered and one guest order, but never reached the normalized
comparison because the unrelated customer-profile relationship gate failed.
Agreement is still pending; no production agreement rate is asserted.

## Minimal correction and provenance

Only `metorik_orders` receives the additional field check. The original five
observations, their evidence IDs, and other adapters' extraction remain unchanged.
A new observation carries provider `metorik_orders`, exact field path
`billing_address_email`, original source/order/record identifiers, provider update
timestamp when available, and retrieval timestamp. Existing conservative email
normalization and conflict handling apply. Guest zero IDs never become identities.
The new field is direct order evidence and does not verify a customer-profile edge.
No schema change, overwrite, automatic collection, publication or activation.

## Bounded Render agreement diagnostic — no deployment required

Paste the following into the deployed application directory. It uses only deployed
`boundedFetch` and `emailState` modules; no new module needs to be deployed, no git
fetch is needed. It makes GET requests only: one page of at most 30 WW Metorik orders,
then up to five exact Woo order reads per stratum (registered and guest as reported
by Metorik). Maximum 11 requests, 45-second total AbortSignal, 50-second shell bound,
2 MiB per response and 8 MiB total decoded bytes. No retries, pagination beyond that
page, customer calls, warehouse access, files or checkpoints. A failed request ends
the diagnostic with partial counts and a sanitized stage. No other stratum is used
to replace an absent one. This is a purposive sample, not population coverage.

Canonical identity requires exact original order ID, UTC creation timestamp and
currency. Display order-number discrepancy is reported separately; its cause
remains unresolved. Timestamp parsing matches the deployed collector's handling
of timezone-free timestamps as UTC. Only usable normalized email pairs enter the
agreement comparison. Null, omitted, empty, malformed, placeholder and invalid-type
fields remain separately counted; unusable pairs and mismatched originals never
count as agreement. Acceptance requires at least one selected order in each stratum
and agreement for every selected order. Output contains counts and fixed provenance
only, never source IDs, dates, order numbers, addresses, raw payloads or credentials.

```bash
timeout --signal=TERM --kill-after=2s 50s node --input-type=module <<'JS'
// Bounded read-only comparison. Output contains no source identifiers or email values.
import {boundedFetch} from './customer-identity/runtime.js';
import {emailState} from './customer-identity/email.js';

const positive=value=>((typeof value==='number'&&Number.isSafeInteger(value))||typeof value==='string')&&/^[1-9]\d*$/.test(String(value))?String(value):null;
const kind=record=>record.customer_id===0||record.customer_id==='0'?'guest':positive(record.customer_id)?'registered':'unknown';
function timestamp(value){
  if(typeof value!=='string')return null;
  const n=Date.parse(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?$/.test(value)?value+'Z':value);
  return Number.isFinite(n)?n:null;
}
function state(record,path){
  let value=record;
  for(const part of path.split('.')){
    if(!value||typeof value!=='object'||!Object.hasOwn(value,part))return {state:'omitted',normalized:null};
    value=value[part];
  }
  return value===null?{state:'null',normalized:null}:typeof value!=='string'?{state:'invalid_type',normalized:null}:
    value.trim()===''?{state:'empty',normalized:null}:emailState(value);
}
const bump=(counts,key)=>{counts[key]=(counts[key]||0)+1;};
export async function diagnoseAgreement({env=process.env,fetchImpl=fetch}={}){
  // One page of 30; first five orders in each stratum. No additional discovery.
  const budget={requests:0,bytes:0,maxRequests:11,maxBytes:8388608};
  const request=boundedFetch(budget,fetchImpl),signal=AbortSignal.timeout(45000);
  const output={read_only:true,provenance:{source:'ww',selection:'first Metorik page: 30 orders; at most 5 per stratum',
    correspondence:'exact Woo order ID, UTC creation timestamp and currency; number compared separately',
    fields:'Woo billing.email; Metorik billing_address_email',normalization:'deployed customer-identity/email.js emailState',customer_profile_lookup:false},
    sampled_orders:0,strata:{registered:{},guest:{}},acceptance:'not_passed'};
  let stage='configuration';
  async function get(url,headers){
    const response=await request(url,{method:'GET',headers,signal,redirect:'error'});
    if(!response.ok)throw Error();
    return response.json();
  }
  try{
    const base=env.WOO_UK_URL;
    if(!env.METORIK_UK_API_KEY||!base||new URL(base).protocol!=='https:'||!env.WOO_UK_CONSUMER_KEY||!env.WOO_UK_CONSUMER_SECRET)throw Error();
    stage='metorik_sample';
    const url=new URL('https://app.metorik.com/api/v1/store/orders');
    url.searchParams.set('page','1');url.searchParams.set('per_page','30');
    const body=await get(url,{Accept:'application/json',Authorization:`Bearer ${env.METORIK_UK_API_KEY}`});
    const rows=Array.isArray(body?.data)?body.data:body?.orders,p=body?.pagination||body?.meta||body?.links;
    if(!Array.isArray(rows)||rows.length>30||rows.some(r=>!r||typeof r!=='object'||Array.isArray(r))||!p||Number(p.current_page)!==1||Number(p.per_page)!==30||typeof p.has_more_pages!=='boolean')throw Error();
    const ids=rows.map(r=>positive(r.order_id));
    if(ids.some(id=>!id)||new Set(ids).size!==ids.length)throw Error();
    output.sampled_orders=rows.length;
    for(const stratum of ['registered','guest']){
      const counts=output.strata[stratum],selected=rows.filter(r=>kind(r)===stratum).slice(0,5);
      counts.selected=selected.length;
      for(const order of selected){
        const billing=state(order,'billing_address_email');bump(counts,`metorik_field/${billing.state}`);
        stage=`${stratum}/native_order`;
        const nativeUrl=new URL(`${base.replace(/\/$/,'')}/wp-json/wc/v3/orders/${positive(order.order_id)}`);
        nativeUrl.searchParams.set('_fields','id,number,customer_id,currency,date_created_gmt,billing.email');
        const native=await get(nativeUrl,{Accept:'application/json',Authorization:'Basic '+Buffer.from(`${env.WOO_UK_CONSUMER_KEY}:${env.WOO_UK_CONSUMER_SECRET}`).toString('base64')});
        const nativeEmail=state(native,'billing.email');bump(counts,`native_field/${nativeEmail.state}`);
        const checks={id:positive(native?.id)===positive(order.order_id),
          timestamp:timestamp(order.order_created_at)!==null&&timestamp(order.order_created_at)===timestamp(native?.date_created_gmt),
          currency:typeof order.currency==='string'&&order.currency.length>0&&order.currency===native?.currency};
        for(const [name,match] of Object.entries(checks))bump(counts,`${name}/${match?'match':'not_matched'}`);
        const numberPresent=order.order_number!=null&&native?.number!=null;
        bump(counts,`number/${!numberPresent?'unavailable':String(order.order_number)===String(native.number)?'match':'different'}`);
        if(!Object.values(checks).every(Boolean)){bump(counts,'identity_not_verified');continue;}
        bump(counts,'identity_verified');
        if(billing.state!=='usable'||nativeEmail.state!=='usable'){bump(counts,'agreement_unevaluable');continue;}
        bump(counts,billing.normalized===nativeEmail.normalized?'normalized_agreement':'normalized_disagreement');
      }
    }
    if(Object.values(output.strata).every(c=>c.selected>0&&c.normalized_agreement===c.selected))output.acceptance='passed_both_strata';
  }catch{
    output.failure_stage=stage;output.failure_category='configuration_request_or_response_contract';
  }
  output.requests=budget.requests;output.response_bytes=budget.bytes;
  return output;
}
const result=await diagnoseAgreement();
console.log(JSON.stringify(result,null,2));
if(result.acceptance!=='passed_both_strata')process.exitCode=2;
JS
```

The same diagnostic can be run as `node diagnostics/metorik-woo-email-agreement.js`
after a future authorized deployment. Do not deploy for this check.

## Proposed additive collection revision — not executed

After the Render check passes and collection is separately authorized, use the
existing adapter with explicit revision `history-20261021-billing-v3`, existing
dataset `customer_identity`, and unchanged historical dates. For a bounded initial
one-page collection, the proposed command is:

```sh
node customer-identity/history.js collect --source=ww --adapter=metorik_orders --dataset=customer_identity --start=1900-01-01 --end=2026-10-19 --batches=1 --revision=history-20261021-billing-v3 --apply
```

This is a proposal, not permission to run it. Do not run it as part of diagnosis.
The selection key includes revision, so this creates independent progress starting
at page one instead of silently returning the completed v2 checkpoint. Existing
`history-20261020-v2` progress stays complete; never delete or reset it. Leaving the
revision unset still selects v2 and may skip extraction; always supply the new
revision. Preserve the same explicit revision for all later resumes of that job.

The evidence MERGE is insert-only by evidence ID. The sixth field has a distinct
field-path key, so earlier five-field failures remain intact and new usable evidence
is appended. Existing unchanged observations deduplicate; changed provider values
remain additive and can produce conflicts. Revision versions collection progress;
field/provider/timestamps provide row provenance under the existing evidence schema.
No misleading conversion of old failures to usable, no latest-value overwrite.

Do not rerun completed rosters or native/customer adapters under v3, and do not
publish using v3 as an all-adapter completion revision: publication currently
requires matching roster and other adapter progress. Publication/activation and
any later full collection plan are outside this PR. USD uses the same corrected
extractor but this Render diagnostic and proposed collection command cover WW only.

## Validation

Regression coverage exercises registered and guest extraction, all unusable field
states, additive conflicting values, exact provenance, idempotent evidence keys,
completed-v2/new-v3 checkpoint separation, normalized agreement, original identity
mismatches, missing strata, privacy, response/request bounds and no retries.
Local fixtures do not establish live Render agreement or customer relationships.
