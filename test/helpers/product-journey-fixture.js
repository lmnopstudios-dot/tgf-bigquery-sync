// Independent aggregate fixture: 22 entry products, 100 entry customers and 10
// returns each. Every return has two known products; one also has unknown lines.
// All 22 first-product cohorts exist before the top-20 entry selection.
export function productJourneyFixture(){
 const rows=[];
 for(const index of [0,...Array.from({length:20},(_,i)=>i+1)])for(const window_days of [0,90,180,360]){
  const overall=index===0,entry_customers=overall?2200:100,returning_customers=overall?220:10;
  const products=Array.from({length:overall?20:5},(_,i)=>({product_ref:`family:shopify:shopify:${String(i+1).padStart(3,'0')}`,product:i===0?'Repurchased ring':`Next product ${i+1}`,family_status:'governed_family',is_sizer:false,customers:i<2?returning_customers:1,denominator_customers:returning_customers,percentage:i<2?100:100/returning_customers,product_rank:i+1,available_products:25}));
  rows.push({entry_product_ref:overall?null:`family:shopify:shopify:entry${String(index).padStart(2,'0')}`,entry_product:overall?'Overall':`First product ${index}`,entry_is_sizer:false,entry_rank:index,window_days,entry_customers,returning_customers,age_eligible_customers:entry_customers,age_repeat_customers:returning_customers,verified_customers:0,verified_repeat_customers:0,missing_line_customers:0,unknown_product_customers:overall?22:1,observation_coverage_status:'unverified',verified_coverage_start:null,verified_coverage_end:null,coverage_evidence:null,products});
 }
 return {cohort_rank:1,window_days:null,population_scope:'linked_tgf',product_journeys:rows,available_entry_products:22,available_sizer_entry_products:0,unknown_entry_customers:0};
}
