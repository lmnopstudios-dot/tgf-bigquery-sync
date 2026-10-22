// Product attribution is supplemental to a validated retention population.
// Unknown identities never become named products or alter cohort/return counts.
const count=n=>n!=null&&n!==''&&typeof n!=='boolean'&&Number.isSafeInteger(Number(n))&&Number(n)>=0;
const counts=(p,row)=>p&&['observed_customers','mature_repeat_customers'].every(k=>count(p[k]))&&Number(p.observed_customers)<=Number(row.observed_repeat_customers)&&Number(p.mature_repeat_customers)<=Number(row.repeat_customers)&&Number(p.mature_repeat_customers)<=Number(p.observed_customers);
const canonicalCounts=(p,row)=>counts(p,row)&&['observed_customers','mature_repeat_customers'].every(k=>Number.isSafeInteger(p[k]));
const coverageKeys=['missing_line_customers','unidentified_product_customers','untitled_product_customers'];
export function assertRetentionProductEvidence(row){
  const products=row.second_order_products,e=row.second_order_product_evidence;
  if(products!=null&&(!Array.isArray(products)||products.length>10||new Set(products.map(p=>p?.product_ref)).size!==products.length||products.some(p=>!canonicalCounts(p,row)||typeof p.product_ref!=='string'||!p.product_ref||typeof p.product!=='string')))throw Error('Invalid second-order products');
  if(e!=null&&(!['partial','unavailable'].includes(e.status)||!Array.isArray(e.unidentified_groups)||e.unidentified_groups.length>10||e.unidentified_groups.some(p=>!canonicalCounts(p,row))||e.status==='partial'&&(!Array.isArray(products)||!e.unidentified_groups.length||products.length+e.unidentified_groups.length>10)||e.status==='unavailable'&&(products!=null||e.unidentified_groups.length)))throw Error('Invalid second-order product evidence');
  if(row.second_order_product_coverage!=null&&coverageKeys.some(k=>!Number.isSafeInteger(row.second_order_product_coverage[k])||row.second_order_product_coverage[k]<0||Number(row.second_order_product_coverage[k])>Number(row.observed_repeat_customers)))throw Error('Invalid second-order product coverage');
}
export function retentionProductEvidence(row){
  try{
    const products=row.second_order_products;
    if(row.second_order_product_evidence){assertRetentionProductEvidence(row);return {second_order_products:products,second_order_product_evidence:row.second_order_product_evidence,...(row.second_order_product_coverage?{second_order_product_coverage:row.second_order_product_coverage}:{})};}
    if(products!=null&&(!Array.isArray(products)||products.length>10))throw Error();
    const known=[],unknown=[];
    for(const p of products||[]){
      if(!counts(p,row))throw Error();
      const values={observed_customers:Number(p.observed_customers),mature_repeat_customers:Number(p.mature_repeat_customers)};
      if(p.product_ref===null){unknown.push(values);continue;}
      // Undefined, empty, non-string and duplicated references remain invalid.
      if(typeof p.product_ref!=='string'||!p.product_ref||typeof p.product!=='string')throw Error();
      known.push({product_ref:p.product_ref,product:p.product,...values});
    }
    const result={...(products!=null?{second_order_products:known}:{}),...(unknown.length?{second_order_product_evidence:{status:'partial',unidentified_groups:unknown}}:{}),...(row.second_order_product_coverage?{second_order_product_coverage:Object.fromEntries(coverageKeys.map(k=>[k,row.second_order_product_coverage[k]]))}:{})};
    if(result.second_order_product_coverage)for(const k of coverageKeys){if(!count(result.second_order_product_coverage[k]))throw Error();result.second_order_product_coverage[k]=Number(result.second_order_product_coverage[k]);}
    assertRetentionProductEvidence({...row,...result});
    return result;
  }catch{
    // Reject attribution, not the independently validated baseline/population.
    return {second_order_products:null,second_order_product_evidence:{status:'unavailable',unidentified_groups:[]}};
  }
}
