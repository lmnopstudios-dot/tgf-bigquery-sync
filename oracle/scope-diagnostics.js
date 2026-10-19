// No values, prompts, raw bodies or identities. Only bounded contract paths/types.
const keys=new Set('operation subject entities scope selected selected_entities comparison_entities reporting_windows candidates query population catalogue_filter selection filters geography_role country comparison_country platform source_store channel channel_breakdown currencies currency metrics metric_definitions numeric_operation requested_operations dimensions grain dates start_date end_date timezone cutoff partial_period current_day_included basis comparison type included_periods promotion exclusions ranking metric direction event_selection name count completion period_structure phases request_detail cohort entry_start entry_end observation_end first_order_semantic entry_classification group_by within_days sort'.split(' '));
const type=v=>v===null?'null':Array.isArray(v)?'array':typeof v;
export function scopeDifferences(expected,actual){
  const differences=[];
  const visit=(a,b,path)=>{
    if(differences.length>=24||JSON.stringify(a)===JSON.stringify(b))return;
    if(type(a)!==type(b)||!a||typeof a!=='object'){differences.push({field:path||'scope',expected_type:type(a),actual_type:type(b)});return;}
    if(Array.isArray(a)){if(a.length!==b.length)differences.push({field:path,expected_type:'array',actual_type:'array',difference:'length'});for(let i=0;i<Math.min(a.length,b.length,5);i++)visit(a[i],b[i],path+'.'+i);return;}
    for(const key of new Set([...Object.keys(a),...Object.keys(b)]))if(keys.has(key))visit(a[key],b[key],path?path+'.'+key:key);
  };
  visit(expected,actual,'');return differences;
}
export function scopeAgreementError(expected,actual){
  const scope_differences=scopeDifferences(expected,actual);
  return Object.assign(Error('Evidence differs from the resolved analytical scope.'),{code:'EVIDENCE_SCOPE_MISMATCH',failed_stage:'evidence_validation',scope_field:'analytical_plan',scope_differences});
}
