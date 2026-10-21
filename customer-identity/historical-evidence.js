import {emailState} from './email.js';

// Additive evidence plan only: never mutates source IDs or chooses a winner.
export function historicalEvidence({store,orderId,metorikCustomerId=null,wooCustomerId=null,observations=[]}) {
  if(!['ww','usd'].includes(store)||!/^\d+$/.test(String(orderId)))throw Error('Invalid source order');
  for(const id of [metorikCustomerId,wooCustomerId])if(id!==null&&!/^\d+$/.test(String(id)))throw Error('Invalid customer identifier');
  if(observations.length>100)throw Error('Evidence cap exceeded');
  const evidence=observations.map(o=>{
    if(!['metorik_api','retained_metorik','retained_woo','woo_api','migration_export'].includes(o.provider)||typeof o.field!=='string'||!o.retrievedAt)throw Error('Missing provenance');
    if(o.value!=null&&(typeof o.value!=='string'||o.value.length>320))throw Error('Invalid email evidence');
    return {...o,...emailState(o.value)};
  });
  const usable=[...new Set(evidence.filter(e=>e.state==='usable').map(e=>e.normalized))];
  return {orderRef:`woo:${store}:${orderId}`,metorikCustomerRef:metorikCustomerId&&String(metorikCustomerId)!=='0'?`metorik:${store}:${metorikCustomerId}`:null,
    wooCustomerRef:wooCustomerId&&String(wooCustomerId)!=='0'?`woo:${store}:${wooCustomerId}`:null,
    evidence,emailState:usable.length>1?'conflict':usable.length===1?'candidate':'unusable',
    normalized:usable.length===1?usable[0]:null,analysisLabel:'email-linked record'};
}

export function emailFields(record,{metorikOrder=false}={}) {
  const fields=['email','billing_email','customer_email','billing.email','customer.email'];
  // Official /orders contract: https://metorik.dev/#orders
  // Add a distinct field observation; never replace earlier extraction failures.
  if(metorikOrder)fields.push('billing_address_email');
  return fields.map(field=>{
    let value=record,present=true;
    for(const part of field.split('.')){if(!value||!Object.hasOwn(value,part)){present=false;break;}value=value[part];}
    const state=!present?'omitted':value===null?'null':typeof value!=='string'?'invalid_type':value.trim()===''?'empty':emailState(value).state;
    return {field,state,value:present?value:undefined};
  });
}
