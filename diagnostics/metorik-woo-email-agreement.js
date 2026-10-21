// Bounded read-only comparison. Output contains no source identifiers or email values.
import {pathToFileURL} from 'node:url';
import {boundedFetch} from '../customer-identity/runtime.js';
import {emailState} from '../customer-identity/email.js';

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
if(import.meta.url===pathToFileURL(process.argv[1]||'').href){
  if(process.argv.length>2)throw Error('Read-only diagnostic takes no arguments');
  diagnoseAgreement().then(result=>{console.log(JSON.stringify(result,null,2));if(result.acceptance!=='passed_both_strata')process.exitCode=2;})
    .catch(()=>{console.error(JSON.stringify({read_only:true,acceptance:'not_passed'}));process.exitCode=2;});
}
