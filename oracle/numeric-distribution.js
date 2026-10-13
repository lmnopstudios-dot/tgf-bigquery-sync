import { evidenceNumber } from './numeric-evidence.js';

// Integer minor units make monetary boundaries and accumulation reproducible.
export function minorUnits(value) {
  const n=evidenceNumber(value);
  if(n==null||n<0||!Number.isSafeInteger(Math.round(n*100)))return null;
  return Math.round((n+Number.EPSILON)*100);
}
export const majorUnits=n=>n==null?null:n/100;
export function validateNumericOperation(value={}) {
  const edges=value.edges||[0,100,125,150,175,200,225,250,275,300,325,350];
  if(!Array.isArray(edges)||edges.length<2||edges.length>100||edges.some((n,i)=>minorUnits(n)==null||i&&minorUnits(n)<=minorUnits(edges[i-1])))throw Error('Invalid numeric band edges');
  const baseline=value.baseline??250,thresholds=value.thresholds||[175,200,225,250,275,300],assumed_charge=value.assumed_charge??8;
  if(minorUnits(baseline)==null||minorUnits(assumed_charge)==null||!Array.isArray(thresholds)||!thresholds.length||thresholds.length>20||thresholds.some(n=>minorUnits(n)==null))throw Error('Invalid threshold parameters');
  if(!['observed_subtotal','observed_total'].includes(value.basis||'observed_subtotal'))throw Error('Invalid observed amount basis');
  return {edges:[...edges],baseline,thresholds:[...new Set(thresholds)],assumed_charge,basis:value.basis||'observed_subtotal',enrich_products:Boolean(value.enrich_products)};
}
/** Weighted, full retrieved population; unknown amounts remain in the denominator.
 * Input weights must come from unique source-qualified orders, never line joins. */
export function numericDistribution(rows,operation) {
  const config=validateNumericOperation(operation),edges=config.edges.map(minorUnits),base=minorUnits(config.baseline),fee=minorUnits(config.assumed_charge);
  const bands=edges.map((lower,i)=>({lower:majorUnits(lower),upper:majorUnits(edges[i+1]),orders:0}));
  const scenarios=config.thresholds.map(threshold=>({threshold,newly_eligible:0,losing_eligibility:0,affected_orders:0,recorded_charge_minor:0,known_charge_orders:0,unknown_charge_orders:0,zero_charge_orders:0,non_standard_charge_orders:0,hypothetical_charge_minor:0}));
  let population=0,unknown_values=0;const gaps=new Map();
  for(const row of rows){
    const count=evidenceNumber(row.orders);
    if(!Number.isSafeInteger(count)||count<0)throw Error('Invalid population count');
    population+=count;if(!Number.isSafeInteger(population))throw Error('Population exceeds numeric precision');
    const amount=minorUnits(row.amount),charge=minorUnits(row.shipping_charge);
    if(amount==null){unknown_values+=count;continue;}
    const index=edges.findLastIndex(edge=>amount>=edge);if(index<0)throw Error('Value outside numeric bands');bands[index].orders+=count;
    for(const s of scenarios){const threshold=minorUnits(s.threshold),before=amount>=base,after=amount>=threshold;if(before===after)continue;
      s.affected_orders+=count;s[after?'newly_eligible':'losing_eligibility']+=count;
      s.hypothetical_charge_minor+=fee*count;
      if(charge==null)s.unknown_charge_orders+=count;
      else {s.known_charge_orders+=count;s.recorded_charge_minor+=charge*count;if(charge===0)s.zero_charge_orders+=count;if(charge!==fee)s.non_standard_charge_orders+=count;}
    }
    const gap=base-amount;if(gap>=1000&&gap<=7500)gaps.set(gap,(gaps.get(gap)||0)+count);
  }
  const safe=n=>{if(!Number.isSafeInteger(n))throw Error('Monetary accumulation exceeds precision');return majorUnits(n);};
  return {population,unknown_values,bands:bands.map(b=>({...b,population_share:population?b.orders/population:null})),scenarios:scenarios.map(({recorded_charge_minor,hypothetical_charge_minor,...s})=>({...s,recorded_shipping_charges:s.known_charge_orders?safe(recorded_charge_minor):s.affected_orders?null:0,hypothetical_fee:safe(hypothetical_charge_minor),charge_total_complete:s.unknown_charge_orders===0})),gaps:[...gaps].sort((a,b)=>a[0]-b[0]).map(([gap,orders])=>({spend_needed:majorUnits(gap),orders,saving:config.assumed_charge,spend_exceeds_saving:gap>fee}))};
}
