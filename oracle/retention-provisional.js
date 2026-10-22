// Age eligibility is independent of continuous-coverage certification. These
// aggregates must be calculated per customer/window, never from report totals.
export const provisionalEligibleSql=alias=>`COALESCE(DATE_ADD(DATE(${alias}.entry_timestamp,@time_zone),INTERVAL window_days DAY)<=@observation_end,FALSE)`;
export const provisionalTotalsSql=`COUNTIF(provisional_eligible) provisional_eligible_customers,
      COUNTIF(provisional_eligible AND days_to_second IS NOT NULL) provisional_repeat_customers,
      SAFE_DIVIDE(COUNTIF(provisional_eligible AND days_to_second IS NOT NULL),COUNTIF(provisional_eligible)) provisional_repeat_rate`;
export function provisionalEvidence(row){
 const keys=['provisional_eligible_customers','provisional_repeat_customers','provisional_repeat_rate'];
 if(row.provisional_rate_rank!=null&&(typeof row.provisional_rate_rank==='boolean'||!Number.isSafeInteger(Number(row.provisional_rate_rank))||Number(row.provisional_rate_rank)<1||row.provisional_repeat_rate==null))throw Error('Invalid provisional ranking');
 if(!keys.some(k=>Object.hasOwn(row,k)))return {}; // Existing retained evidence stays readable.
 const number=k=>{const x=row[k];if(x==null||x===''||typeof x==='boolean'||!Number.isSafeInteger(Number(x))||Number(x)<0)throw Error('Invalid provisional denominator');return Number(x);};
 const denominator=number(keys[0]),numerator=number(keys[1]),rate=denominator?numerator/denominator:null;
 if(numerator>denominator||denominator>Number(row.cohort_customers)||numerator>Number(row.observed_repeat_customers)||Number(row.mature_customers)>denominator||Number(row.repeat_customers)>numerator||!Object.hasOwn(row,keys[2])||(rate===null?row[keys[2]]!==null:row[keys[2]]==null||row[keys[2]]===''||typeof row[keys[2]]==='boolean'||!Number.isFinite(Number(row[keys[2]]))||Math.abs(Number(row[keys[2]])-rate)>1e-9))throw Error('Invalid provisional denominator');
 return {[keys[0]]:denominator,[keys[1]]:numerator,[keys[2]]:rate};
}
export function familyEvidence(row){
 if(row.entry_family_status==null)return {};
 if(!['governed_family','unmapped_item','ambiguous_family'].includes(row.entry_family_status)||!row.entry_product_ref||(row.entry_family_status==='governed_family')!==row.entry_product_ref.startsWith('family:'))throw Error('Invalid retention family');
 return {entry_family_status:row.entry_family_status};
}
