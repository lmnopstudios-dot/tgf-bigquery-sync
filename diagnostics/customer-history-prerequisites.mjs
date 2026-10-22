// Standalone Render preflight. SELECT/GET and IAM policy reads only. No setup.
import {BigQuery} from '@google-cloud/bigquery';
import {google} from 'googleapis';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';

export async function preflight({bigquery,request,project,principal,emit=console.log,maximumMs=100000}){
  const started=Date.now(),deadline=started+maximumMs,active=new Set(),results={};
  const safeCode=e=>{const n=Number(e?.response?.status||e?.code);return [400,401,403,404,408,409,429,500,502,503,504].includes(n)?n:null;};
  const safeReason=e=>[e?.code,e?.cause?.code,...(e?.response?.data?.error?.details||[]).map(x=>x.reason)].find(x=>['ECONNREFUSED','ECONNRESET','ENOTFOUND','ETIMEDOUT','EAI_AGAIN','SERVICE_DISABLED','ACCESS_TOKEN_SCOPE_INSUFFICIENT','IAM_PERMISSION_DENIED','PERMISSION_DENIED'].includes(x))||null;
  const error=(kind,permissions=[],action)=>Object.assign(Error(kind),{kind,permissions,action});
  const bound=async(work,end=deadline,ms=5000)=>{let timer;const remaining=Math.min(end,deadline)-Date.now();
    if(remaining<=0)throw error('deadline',[],'Run a narrower administrator inspection; do not infer absence from a timeout.');
    try{return await Promise.race([work(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(error('deadline',[],'The bounded inspection did not complete.')),Math.min(ms,remaining));})]);}
    finally{clearTimeout(timer);}
  };
  const api=async(path,{method='GET',data,permissions=[],end=deadline}={})=>{
    try{const r=await bound(()=>request({url:'https://'+path,method,data,timeout:5000,retry:false,retryConfig:{retry:0}}),end);return r.data;}
    catch(e){e.resource=path.split('?')[0];if(!e.kind){e.kind='access_or_api_unavailable';e.permissions=permissions;e.action='Administrator: allow the listed read permissions and required API; preserve the existing credential configuration.';}throw e;}
  };
  const failureFields=e=>{
    const reason=safeReason(e),network=['ECONNREFUSED','ECONNRESET','ENOTFOUND','ETIMEDOUT','EAI_AGAIN'].includes(reason);
    return {status:'unknown',failure:network?'network_unavailable':e.kind||'access_or_api_unavailable',http_status:safeCode(e),reason,resource:e.resource||null,
      required_permissions:network?[]:e.permissions||[],
      action:network?'Restore approved HTTPS reachability to Google APIs through the configured proxy; missing IAM permissions have not been established.':reason==='SERVICE_DISABLED'?'Administrator: enable the API named by this resource using serviceusage.services.enable; do not infer missing data permissions from a disabled service.':e.action||'Administrator: inspect the named prerequisite; no missing setup or repair has been inferred.'};
  };
  const quote=String.fromCharCode(96),table=n=>quote+project+'.customer_identity.'+n+quote;
  const queryIds={guard:'history_preflight_'+randomUUID().replaceAll('-',''),jobs:'history_preflight_'+randomUUID().replaceAll('-','')};
  const query=async(sql,location,end,tag)=>{
    const id=queryIds[tag];let allocated=bigquery.job(id,{location});active.add(allocated);
    const limit=Math.min(end,deadline,Date.now()+17000);
    try{
      const [job]=await bound(()=>bigquery.createQueryJob({jobId:id,location,query:sql,params:{self:id,preflight_jobs:Object.values(queryIds)},useLegacySql:false,maximumBytesBilled:'1000000000',jobTimeoutMs:15000,labels:{component:'history_preflight',operation:'read_only'}}),limit,16000);
      active.delete(allocated);allocated=job;active.add(job);let rows=[],next={},meta;
      do{const [page,continuation,response]=await bound(()=>job.getQueryResults({...next,autoPaginate:false,maxResults:4,timeoutMs:1000}),limit,16000);
        meta=response;if(response?.jobComplete!==false)rows.push(...page);next=continuation;
        if(rows.length>3)throw error('result_bound');
      }while(next||meta?.jobComplete===false);
      active.delete(job);return rows;
    }catch(e){allocated.cancel({maxRetries:0}).catch(()=>{});active.delete(allocated);throw e;}
  };
  const report=(name,value)=>{results[name]=value;emit(JSON.stringify({read_only:true,check:name,...value}));};
  const independent=async(name,work)=>{try{report(name,await work());}catch(e){report(name,failureFields(e));}};
  let sourceMeta,sourceError;
  try{[sourceMeta]=await bound(()=>bigquery.dataset('customer_identity').getMetadata(),deadline,6000);}catch(e){sourceError=e;}
  const location=sourceMeta?.location;
  report('configuration',{status:'observed',project,location:location||null,account_identity_known:Boolean(principal),source_metadata_http_status:sourceError?safeCode(sourceError):null,source_metadata_reason:sourceError?safeReason(sourceError):null});

  await Promise.all([
    independent('publication_guard',async()=>{
      let meta;
      try{[meta]=await bound(()=>bigquery.dataset('customer_identity').table('identity_publication_guard').getMetadata(),deadline,6000);}
      catch(e){if(safeCode(e)===404&&sourceMeta)return {status:'missing',exists:false,action:'Separately authorize the one-time unpartitioned guard migration after all old publishers are quiescent and their jobs terminal. Do not create or seed it in this preflight.'};
        e.permissions=['bigquery.tables.get'];e.action='Administrator: grant table metadata read access on customer_identity; a denied metadata read does not establish absence.';throw e;}
      const fields=meta.schema?.fields||[];
      const validSchema=fields.length===2&&fields.some(f=>f.name==='guard_id'&&f.type==='STRING'&&f.mode!=='REPEATED')&&fields.some(f=>f.name==='generation'&&['INTEGER','INT64'].includes(f.type)&&f.mode!=='REPEATED');
      if(meta.type!=='TABLE'||meta.timePartitioning||meta.rangePartitioning||!validSchema)return {status:'invalid',exists:true,unpartitioned:!meta.timePartitioning&&!meta.rangePartitioning,schema_valid:validSchema,action:'Administrator: inspect the existing guard definition. Do not replace, reseed or append a singleton automatically.'};
      if(!location)throw error('source_location_unavailable',['bigquery.datasets.get'],'Administrator: grant metadata read access on customer_identity; row validity is still unknown.');
      let rows;try{rows=await query("SELECT COUNT(*) row_count,COUNTIF(guard_id='publication' AND generation IS NOT NULL AND generation>=0 AND generation<9223372036854775807) valid_rows FROM "+table('identity_publication_guard'),location,Math.min(deadline,Date.now()+18000),'guard');}
      catch(e){e.permissions=['bigquery.jobs.create','bigquery.tables.getData'];e.action='Administrator: grant query submission on the project and read access on the guard. Existing schema was readable; singleton validity remains unknown.';throw e;}
      if(rows.length!==1)throw error('invalid_result');
      const count=Number(rows[0].row_count),valid=count===1&&Number(rows[0].valid_rows)===1;
      return {status:valid?'valid':'invalid',exists:true,unpartitioned:true,schema_valid:true,row_count:count,valid_rows:Number(rows[0].valid_rows),action:valid?'No guard setup is needed.':'Administrator: inspect the existing rows; do not append or reseed. No repair may run against this guard.'};
    }),
    independent('project_active_jobs',async()=>{
      if(!location)throw error('source_location_unavailable',['bigquery.datasets.get'],'Administrator: grant dataset metadata read access to determine the actual query region.');
      let rows;try{rows=await query("SELECT COUNT(*) active_jobs,COUNTIF(job_type='QUERY') active_query_jobs,COUNTIF(job_type='LOAD') active_load_jobs FROM "+quote+project+'.region-'+location.toLowerCase()+'.INFORMATION_SCHEMA.JOBS_BY_PROJECT'+quote+" WHERE state IN ('PENDING','RUNNING') AND job_id!=@self AND (parent_job_id IS NULL OR parent_job_id!=@self) AND job_id NOT IN UNNEST(@preflight_jobs) AND (parent_job_id IS NULL OR parent_job_id NOT IN UNNEST(@preflight_jobs))",location,Math.min(deadline,Date.now()+18000),'jobs');}
      catch(e){e.permissions=['bigquery.jobs.create','bigquery.jobs.listAll'];e.action='Administrator: grant roles/bigquery.jobUser and roles/bigquery.resourceViewer on this project, or minimal custom roles containing bigquery.jobs.create and bigquery.jobs.listAll. JOBS_BY_USER is insufficient.';throw e;}
      if(rows.length!==1)throw error('invalid_result');
      return {status:'verified',can_inspect_project_wide:true,active_jobs:Number(rows[0].active_jobs),active_query_jobs:Number(rows[0].active_query_jobs),active_load_jobs:Number(rows[0].active_load_jobs),action:Number(rows[0].active_jobs)?'Visibility is established. Quiesce publication launch paths and reconcile relevant active jobs before repair; do not cancel unrelated jobs.':'Visibility is established. Repeat the fresh check immediately before repair; zero active jobs does not prove cross-host writer quiescence.'};
    }),
    independent('restricted_backup_dataset',async()=>{
      const end=Math.min(deadline,Date.now()+80000),maxDatasets=20,maxRoles=40;
      // All principals remain in memory; only grant counts and resource names leave.
      const roles=new Map();let roleReads=0;
      const permissionsFor=async role=>{
        const aliases={OWNER:'roles/bigquery.dataOwner',WRITER:'roles/bigquery.dataEditor',READER:'roles/bigquery.dataViewer'};
        role=aliases[role]||role;
        if(roles.has(role))return roles.get(role);
        if(++roleReads>maxRoles)throw error('role_inspection_bound',[],'Administrator: provide a narrower policy inspection; role enumeration was incomplete.');
        if(!new RegExp('^(?:roles/[A-Za-z0-9_.]+|(?:projects|organizations)/[A-Za-z0-9_-]+/roles/[A-Za-z0-9_.]+)$').test(role||''))throw error('unsupported_role',['iam.roles.get']);
        const p=api('iam.googleapis.com/v1/'+role,{permissions:['iam.roles.get'],end}).then(x=>{if(!Array.isArray(x.includedPermissions)||x.deleted)throw error('role_definition_incomplete',['iam.roles.get']);return x.includedPermissions;});roles.set(role,p);return p;
      };
      const isSelf=member=>Boolean(principal)&&[principal,'serviceAccount:'+principal,'user:'+principal].includes(member);
      const relevant=ps=>ps.some(p=>['bigquery.tables.getData','bigquery.tables.export','bigquery.tables.updateData','bigquery.tables.setIamPolicy','bigquery.datasets.update','bigquery.datasets.setIamPolicy','bigquery.tables.create'].includes(p)||p==='*'||p.startsWith('bigquery.')&&p.endsWith('*'));
      let hierarchyComplete=false,inherited=[],hierarchyFailure=null;
      try{
        let resource='projects/'+project;
        for(let depth=0;depth<10;depth++){
          const kind=resource.split('/')[0];
          const policy=await api('cloudresourcemanager.googleapis.com/v3/'+resource+':getIamPolicy',{method:'POST',data:{options:{requestedPolicyVersion:3}},permissions:['resourcemanager.'+kind+'.getIamPolicy'],end});
          inherited.push(...(policy.bindings||[]));
          if(kind==='organizations'){hierarchyComplete=true;break;}
          const meta=await api('cloudresourcemanager.googleapis.com/v3/'+resource,{permissions:['resourcemanager.'+kind+'.get'],end});
          if(!meta.parent){hierarchyComplete=true;break;}
          if(!new RegExp('^(folders|organizations)/[0-9]+$').test(meta.parent))throw error('unsupported_ancestor');
          resource=meta.parent;
        }
        if(!hierarchyComplete)throw error('ancestor_inspection_bound');
      }catch(e){hierarchyFailure={...failureFields(e)};}
      let inheritedForeign=0,inheritedConditional=0,inheritedUnknown=0;
      const selfPermissions=new Set();
      for(const b of inherited){try{const ps=await permissionsFor(b.role);if(!relevant(ps))continue;
        if(b.condition)inheritedConditional++;
        for(const member of b.members||[]){if(!isSelf(member))inheritedForeign++;else if(!b.condition)ps.forEach(p=>selfPermissions.add(p));}
      }catch{inheritedUnknown++;}}
      let inventory,inventoryFailure=null;
      try{inventory=await api('bigquery.googleapis.com/bigquery/v2/projects/'+project+'/datasets?all=true&maxResults=21',{permissions:['bigquery.datasets.get'],end});}
      catch(e){e.action='Administrator: provide dataset metadata visibility. A permission-filtered or denied listing does not establish absence.';inventory={datasets:[]};inventoryFailure=failureFields(e);}
      const listed=inventory.datasets||[],candidates=[];let inspected=0,unreadable=0;
      for(const entry of listed.slice(0,maxDatasets)){
        if(Date.now()>=end-5500)break;
        const id=entry.datasetReference?.datasetId;
        if(!/^[A-Za-z0-9_]+$/.test(id||'')||id==='customer_identity')continue;
        let md;try{md=await api('bigquery.googleapis.com/bigquery/v2/projects/'+project+'/datasets/'+id+'?datasetView=FULL',{permissions:['bigquery.datasets.get'],end});}
        catch{unreadable++;continue;}
        inspected++;
        if(!location||String(md.location).toLowerCase()!==location.toLowerCase())continue;
        let foreign=0,conditional=0,unknown=Array.isArray(md.access)?0:1;const own=new Set(selfPermissions);
        for(const a of md.access||[]){
          if(a.view||a.routine||a.dataset||a.domain||a.specialGroup||a.groupByEmail){foreign++;continue;}
          const who=a.iamMember||a.userByEmail;
          if(!who||!a.role){unknown++;continue;}
          try{const ps=await permissionsFor(a.role);if(!relevant(ps))continue;if(a.condition)conditional++;
            if(!isSelf(who))foreign++;else if(!a.condition)ps.forEach(p=>own.add(p));
          }catch{unknown++;}
        }
        const noTtl=!Number(md.defaultTableExpirationMs||0);
        const restricted=Boolean(principal)&&hierarchyComplete&&!hierarchyFailure&&!inheritedForeign&&!inheritedConditional&&!inheritedUnknown&&!foreign&&!conditional&&!unknown;
        candidates.push({dataset:project+'.'+id,location:md.location,default_table_expiration_absent:noTtl,
          restriction_status:restricted?'verified_for_configured_account_only':'not_verified',
          direct_other_or_authorized_grants:foreign,direct_conditional_grants:conditional,direct_unresolved_roles:unknown,
          unconditional_create_grant_observed:own.has('bigquery.tables.create')||own.has('*'),
          status:restricted&&noTtl&&(own.has('bigquery.tables.create')||own.has('*'))?'verified_candidate':'not_ready'});
      }
      const verified=candidates.filter(x=>x.status==='verified_candidate');
      return {status:verified.length===1?'verified_destination':verified.length>1?'multiple_verified_candidates':'no_verified_destination',
        destination:verified.length===1?verified[0].dataset:null,
        inventory_scope:'permission-visible datasets in the configured project only',
        inventory_failure:inventoryFailure,required_permissions:[...new Set([...(hierarchyFailure?.required_permissions||[]),...(inventoryFailure?.required_permissions||[]),...(inheritedUnknown||candidates.some(x=>x.direct_unresolved_roles)?['iam.roles.get']:[])])],
        inventory_truncated:Boolean(inventoryFailure)||Boolean(inventory.nextPageToken)||listed.length>maxDatasets||inspected+unreadable<listed.filter(x=>x.datasetReference?.datasetId!=='customer_identity').length,
        inspected_datasets:inspected,unreadable_datasets:unreadable,hierarchy_complete:hierarchyComplete&&!hierarchyFailure,
        hierarchy_failure:hierarchyFailure,inherited_other_relevant_grants:inheritedForeign,inherited_conditional_grants:inheritedConditional,inherited_unresolved_roles:inheritedUnknown,
        principal_scope:'Strict automated criterion: only the configured account has relevant data/writer grants; other principals are not presumed approved. Deny policies can further restrict access; write success is not claimed from an allow grant.',
        candidates,action:verified.length===1?'Existing destination and inspected allow-policy restrictions are established; revalidate policies before repair. No backup dataset creation is indicated.':
          'Administrator: inspect the named policy/visibility gaps. If no suitable destination exists, provision a same-location restricted backup dataset with explicit service-account access and no table TTL; inherited grants cannot be removed with dataset ACL edits. An isolated backup project may be required. No dataset creation is inferred from a permission-filtered or incomplete listing.'};
    })
  ]);
  for(const job of active)job.cancel({maxRetries:0}).catch(()=>{});
  return results;
}

async function main(){
  let credentials,project;
  try{credentials=process.env.GOOGLE_SERVICE_ACCOUNT_JSON?JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON):undefined;
    project=process.env.GOOGLE_PROJECT_ID||credentials?.project_id;
    if(!/^[A-Za-z0-9_-]+$/.test(project||''))throw Error('configuration');
  }catch{for(const check of ['publication_guard','project_active_jobs','restricted_backup_dataset'])console.log(JSON.stringify({read_only:true,check,status:'unknown',failure:'configuration',action:'Restore the existing valid Google project and service-account configuration; never print credentials.'}));process.exitCode=2;return;}
  const bq=new BigQuery({projectId:project,credentials,autoRetry:false,maxRetries:0});
  const auth=new google.auth.GoogleAuth({projectId:project,credentials,scopes:['https://www.googleapis.com/auth/cloud-platform']});
  // OAuth token retrieval is bounded by the independent request calls.
  const request=async settings=>{const client=await auth.getClient();return client.request(settings);};
  const timer=setTimeout(()=>{console.error(JSON.stringify({read_only:true,status:'process_deadline',action:'Keep every missing prerequisite unknown; no setup or repair was performed.'}));process.exit(2);},110000);
  try{await preflight({bigquery:bq,request,project,principal:credentials?.client_email});}
  finally{clearTimeout(timer);}
}
if(!process.argv[1]||import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.error(JSON.stringify({read_only:true,status:'preflight_stopped',action:'No setup or repair was performed. Preserve independent results already printed.'}));process.exitCode=2;});
