// Aggregate fixture for HTTP/browser delivery. Arithmetic is also exercised by
// the real generated SQL against the separate synthetic transaction fixture.
export function collaborationJourneyFixture(){
 const rows=[];
 for(const [cohort_type,collaboration_name,collaboration_product_ref,label,rank,entries,returns] of [
  ['overall',null,null,'Overall',0,5,4],
  ['collaboration','alpha',null,'alpha',1,4,4],
  ['collaboration','beta',null,'beta',2,2,1],
  ['item','alpha','family:A','Alpha ring',1,3,3],
  ['item','alpha','family:B','Alpha chain',2,2,2],
  ['item','beta','family:C','Beta ring',3,2,1]
 ])for(const window_days of [0,90,180,360]){
  const returning_customers=window_days===0?returns:cohort_type==='overall'||collaboration_name==='alpha'?returns-1:returns;
  const known=cohort_type==='overall'?returning_customers-1:Math.max(0,returning_customers-1);
  rows.push({cohort_type,collaboration_name,collaboration_product_ref,entry_product_ref:cohort_type==='overall'?null:JSON.stringify([cohort_type,collaboration_name,collaboration_product_ref]),entry_product:label,entry_is_sizer:false,entry_rank:rank,window_days,entry_customers:entries,returning_customers,age_eligible_customers:entries,age_repeat_customers:returning_customers,verified_customers:0,verified_repeat_customers:0,missing_line_customers:1,unknown_product_customers:0,observation_coverage_status:'unverified',verified_coverage_start:null,verified_coverage_end:null,coverage_evidence:null,products:known?[{product_ref:'family:CORE',product:'Core range ring',family_status:'governed_family',is_sizer:false,customers:known,denominator_customers:returning_customers,percentage:100*known/returning_customers,product_rank:1,available_products:1}]:[]});
 }
 return {cohort_rank:1,window_days:null,population_scope:'linked_tgf',collaboration_journeys:rows,available_collaborations:2,available_items:3,available_sizer_items:0};
}
