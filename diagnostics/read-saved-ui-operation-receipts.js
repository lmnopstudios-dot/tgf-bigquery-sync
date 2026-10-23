import {readFileSync,statSync} from 'node:fs';
const file='/tmp/oracle-ui-product-routes-383.json';
if(statSync(file).size>16777216)throw Error('Evidence file bound exceeded');
const evidence=JSON.parse(readFileSync(file,'utf8'));
const fields=['operation_id','row_index','row_request_id','request_id','action','source_ref','shopify_parent_ref','status','decision_event_id','decision_id','event_id','left_ref','right_ref','relationship_id','supersedes_decision_id','replacement_for_decision_id','provenance','recorded_at','reviewed_at'];
const checks=(evidence.checks||[]).filter(c=>/^ui_persisted_(operation|outcome|identity|family)$/.test(c.check));
if(checks.length!==4)throw Error('Expected four saved persisted-evidence checks');
const output=checks.map(c=>{
 if(c.status!=='read_completed'||!Array.isArray(c.rows))return {check:c.check,status:c.status,job_id:c.job_id,unavailable:true};
 if(c.rows.length>502)throw Error('Saved result bound exceeded');
 const inventory=c.rows.find(r=>r.kind==='inventory');
 const records=c.rows.filter(r=>r.kind==='record').map(r=>{
  const raw=typeof r.record==='string'?JSON.parse(r.record):r.record;
  return Object.fromEntries(fields.filter(k=>raw[k]!==undefined).map(k=>[k,raw[k]]));
 });
 return {check:c.check,job_id:c.job_id,inventory:inventory?.record,records};
});
console.log(JSON.stringify({read_only:true,queries_submitted:0,evidence_file:file,checks:output}));
