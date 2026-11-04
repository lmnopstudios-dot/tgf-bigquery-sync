const fail=(code,missing)=>Object.assign(Error(code),{code,missing});
// Brand expansion is spelling normalisation, never a geographic alias.
// In particular, East and Shoreditch remain different names.
export const squareStoreName=value=>String(value||'').trim().replace(/^(?:the\s+great\s+frog|tgf)\s+/i,'').replace(/\s+/g,' ').toLowerCase();
export function verifiedSquareLocation(rows,window){
 const name=squareStoreName(window.location_name),matches=new Map();
 for(const r of rows){
  if(r.has_persisted_location_metadata!==true||!r.location_id||/^gid:\/\//i.test(r.location_id)||squareStoreName(r.location_name)!==name)continue;
  const set=matches.get(r.location_id)||[];set.push(r);matches.set(r.location_id,set);
 }
 if(matches.size!==1)throw fail(matches.size?'EVENT_LOCATION_AMBIGUOUS':'EVENT_LOCATION_NOT_VERIFIED',[`${window.location_name}: ${matches.size?'multiple native Square IDs match the persisted store name':'no persisted native Square ID matches the store name (including brand-expanded and inactive records)'}`]);
 const [location_id,evidence]=[...matches][0];
 const all=rows.filter(r=>r.location_id===location_id&&r.has_persisted_location_metadata===true);
 const zones=new Set(all.map(r=>r.timezone).filter(Boolean));
 if(zones.size!==1||!['Europe/London','GMT','UTC'].includes([...zones][0]))throw fail('EVENT_STORE_TIMEZONE_NOT_VERIFIED',[`${window.location_name}: missing or conflicting Square timezone metadata`]);
 const created=all.map(r=>r.created_at?.value||r.created_at).filter(Boolean).map(Date.parse);
 if(created.length&&(!created.every(Number.isFinite)||Math.min(...created)>Date.parse(window.start_at)))throw fail('EVENT_LOCATION_NOT_VERIFIED',[`${window.location_name}: native Square location creation does not establish existence at the sale window`]);
 return {location_id,location_evidence:{...evidence[0],timezone:[...zones][0],matched_names:[...new Set(evidence.map(r=>r.location_name))],persisted_names:[...new Set(all.map(r=>r.location_name))],sources:[...new Set(all.map(r=>r.source))],observed_at:new Date().toISOString()}};
}
export async function bindSquareLocation(execute,project,window){
 const queries=[
  ['square_data.retail_locations',`SELECT location_id,location_name,timezone,has_persisted_location_metadata,location_status,created_at FROM \`${project}.square_data.retail_locations\``],
  ['square_data.locations',`SELECT COALESCE(JSON_VALUE(j,'$.location_id'),JSON_VALUE(j,'$.id')) location_id,COALESCE(JSON_VALUE(j,'$.name'),JSON_VALUE(j,'$.location_name')) location_name,COALESCE(JSON_VALUE(j,'$.timezone'),JSON_VALUE(j,'$.time_zone')) timezone,COALESCE(JSON_VALUE(j,'$.name'),JSON_VALUE(j,'$.location_name')) IS NOT NULL has_persisted_location_metadata,COALESCE(JSON_VALUE(j,'$.status'),JSON_VALUE(j,'$.location_status')) location_status,JSON_VALUE(j,'$.created_at') created_at FROM(SELECT TO_JSON(l,stringify_wide_numbers=>TRUE) j FROM \`${project}.square_data.locations\` l)`]
 ];
 // The semantic view chooses a single metadata row per ID; also inspect raw
 // persisted rows so an inactive/renamed row is not hidden by that projection.
 const reads=await Promise.allSettled(queries.map(async([source,q])=>(await execute(q,{})).map(r=>({...r,source}))));
 const stopped=reads.find(r=>r.status==='rejected'&&['EVENT_DEADLINE_EXCEEDED','REQUEST_CANCELLED','LEASE_NOT_OWNED'].includes(r.reason?.code));if(stopped)throw stopped.reason;
 if(reads.every(r=>r.status==='rejected'))throw fail('EVENT_LOCATION_NOT_VERIFIED',[`${window.location_name}: persisted Square metadata could not be read`]);
 return verifiedSquareLocation(reads.flatMap(r=>r.status==='fulfilled'?r.value:[]),window);
}
