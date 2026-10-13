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
export function numericDistribution(rows,operation,coverage={}) {
  const config=validateNumericOperation(operation),edges=config.edges.map(minorUnits),base=minorUnits(config.baseline),fee=minorUnits(config.assumed_charge);
  const bands=edges.map((lower,i)=>({lower:majorUnits(lower),upper:majorUnits(edges[i+1]),orders:0}));
  const scenarios=config.thresholds.map(threshold=>({threshold,newly_eligible:0,losing_eligibility:0,affected_orders:0,eligible_orders:0,eligible_known_charge_orders:0,eligible_unknown_charge_orders:0,eligible_charge_minor:0,basket_gaps:[10,25,50].map(upper=>({lower:upper===10?0:upper===25?10:25,upper,orders:0,within_orders:0})),recorded_charge_minor:0,known_charge_orders:0,unknown_charge_orders:0,zero_charge_orders:0,non_standard_charge_orders:0,hypothetical_charge_minor:0}));
  let population=0,unknown_values=0,merchandise_valid_orders=0,merchandise_sum_minor=0;const gaps=new Map(),merchandise=new Map();
  for(const row of rows){
    const count=evidenceNumber(row.orders);
    if(!Number.isSafeInteger(count)||count<0)throw Error('Invalid population count');
    population+=count;if(!Number.isSafeInteger(population))throw Error('Population exceeds numeric precision');
    const amount=minorUnits(row.amount),charge=minorUnits(row.shipping_charge);
    const merchandiseAmount=minorUnits(Object.hasOwn(row,'merchandise_amount')?row.merchandise_amount:config.basis==='observed_subtotal'?row.amount:null);
    if(merchandiseAmount!=null){merchandise_valid_orders+=count;merchandise_sum_minor+=merchandiseAmount*count;merchandise.set(merchandiseAmount,(merchandise.get(merchandiseAmount)||0)+count);}
    for(const s of scenarios){
      if(amount==null)continue;
      const gap=minorUnits(s.threshold)-amount;
      for(const g of s.basket_gaps){if(gap>0&&gap<=minorUnits(g.upper))g.within_orders+=count;if(gap>minorUnits(g.lower)&&gap<=minorUnits(g.upper))g.orders+=count;}
      if(gap<=0){s.eligible_orders+=count;if(charge==null)s.eligible_unknown_charge_orders+=count;else{s.eligible_known_charge_orders+=count;s.eligible_charge_minor+=charge*count;}}
    }
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
  const verified=coverage.complete===true&&coverage.population_complete==='verified';
  const unavailable=population===0&&!verified;
  const observed=observedMerchandiseStatistics(merchandise,merchandise_valid_orders,merchandise_sum_minor,population);
  return {population,unknown_values,observed_merchandise:observed,population_status:population?'retrieved':verified?'verified_empty_eligible_population':'unverified_empty_population',bands:bands.map(b=>({...b,population_share:population?b.orders/population:null})),scenarios:scenarios.map(({recorded_charge_minor,hypothetical_charge_minor,eligible_charge_minor=0,...s})=>({...s,observed_merchandise_mean:observed.mean,recorded_shipping_potentially_forgone:unavailable?null:s.eligible_known_charge_orders?safe(eligible_charge_minor):s.eligible_orders?null:0,recorded_shipping_per_eligible_order:!unavailable&&s.eligible_orders&&s.eligible_known_charge_orders?safe(eligible_charge_minor)/s.eligible_orders:null,shipping_denominator:s.eligible_orders||0,shipping_denominator_definition:'All retrieved orders with known observed amount >= scenario threshold; numerator is partial known recorded shipping, unknown charges remain in denominator.',recorded_shipping_charges:unavailable?null:s.known_charge_orders?safe(recorded_charge_minor):s.affected_orders?null:0,hypothetical_fee:unavailable?null:safe(hypothetical_charge_minor),charge_total_complete:!unavailable&&unknown_values===0&&s.unknown_charge_orders===0,evidence_complete:verified&&unknown_values===0&&s.unknown_charge_orders===0})),gaps:[...gaps].sort((a,b)=>a[0]-b[0]).map(([gap,orders])=>({spend_needed:majorUnits(gap),orders,saving:config.assumed_charge,spend_exceeds_saving:gap>fee}))};
}

// Exact weighted order statistics from equal-value order groups, never band centres.
export function observedMerchandiseStatistics(values,valid_orders,sum_minor,population) {
  if(!Number.isSafeInteger(sum_minor))throw Error('Monetary accumulation exceeds precision');
  const ranks=[Math.floor((valid_orders+1)/2),Math.floor((valid_orders+2)/2)];
  let cumulative=0;const middle=[];
  for(const [amount,count] of [...values].sort((a,b)=>a[0]-b[0])){const before=cumulative;cumulative+=count;for(const rank of ranks)if(rank>before&&rank<=cumulative)middle.push(amount);}
  return {basis:'observed_subtotal',valid_orders,unknown_orders:population-valid_orders,sum:sum_minor/100,mean:valid_orders?sum_minor/100/valid_orders:null,median:valid_orders?middle.reduce((a,b)=>a+b,0)/200:null,definition:'Exact observed discounted merchandise subtotal, shipping excluded; tax inclusion unverified. Denominator: retrieved orders with valid nonnegative merchandise amount. Stored ambiguous zeros are unknown. Static across threshold scenarios.'};
}
