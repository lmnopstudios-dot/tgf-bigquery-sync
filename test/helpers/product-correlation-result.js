// Expected aggregates of the diagnostic's synthetic c1–c4 fixture. No customer
// data is used. Tests exercise the populated path, which the empty check cannot.
export function productCorrelationResult(){
 const rows=[];
 for(const ref of [null,'family:A','family:B'])for(const days of [0,90,180,360]){
  const overall=ref===null,primary=days===0,entry=overall?4:2,returns=overall?(primary?3:2):ref==='family:A'?(primary?2:1):(primary?1:0);
  const names=ref==='family:B'?[]:overall?['B','A','Ring Sizer']:['A','B','Ring Sizer'];
  const products=names.map((name,i)=>{const sizer=name==='Ring Sizer',customers=overall&&name==='B'?2:1;return {product_ref:'family:'+name,product:name,family_status:'governed_family',is_sizer:sizer,customers,product_rank:sizer?1:i+1,available_products:sizer?1:2,denominator_customers:returns,percentage:100*customers/returns};});
  rows.push({entry_product_ref:ref,entry_product:overall?'Overall':ref.slice(7),entry_is_sizer:false,entry_rank:overall?0:ref==='family:A'?1:2,window_days:days,
   entry_customers:entry,returning_customers:returns,age_eligible_customers:entry,age_repeat_customers:returns,verified_customers:0,verified_repeat_customers:0,
   missing_line_customers:primary?1:0,unknown_product_customers:ref==='family:B'?0:1,observation_coverage_status:'unverified',products});
 }
 return {product_journeys:rows,unknown_entry_customers:1,available_entry_products:2};
}
