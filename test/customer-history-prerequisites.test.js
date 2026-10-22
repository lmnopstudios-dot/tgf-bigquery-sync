import test from 'node:test';
import assert from 'node:assert/strict';
import {preflight} from '../diagnostics/customer-history-prerequisites.mjs';

const principal='private-fixture@example.invalid';
const denied=()=>Object.assign(Error('private provider body and credential'),{code:403});
function fixture({guard='valid',jobs='visible',policy='self',inventory='visible',ttl=0,grant='OWNER',roleDenied=false,parent=false}={}){
  const calls=[],outputs=[];
  const bigquery={dataset:()=>({getMetadata:async()=>[{location:'EU'}],table:()=>({getMetadata:async()=>{
    if(guard==='missing')throw Object.assign(Error('private'),{code:404});
    if(guard==='denied')throw denied();
    return [{type:'TABLE',...(guard==='partitioned'?{timePartitioning:{type:'DAY'}}:{}),schema:{fields:[{name:'guard_id',type:'STRING'},{name:'generation',type:'INTEGER'}]}}];
  }})}),job:id=>({id,cancel:async()=>{}}),createQueryJob:async settings=>{
    calls.push(settings);
    assert.match(settings.query,/^SELECT /);assert.equal(settings.jobTimeoutMs,15000);
    const isJobs=settings.query.includes('JOBS_BY_PROJECT');
    if(isJobs&&jobs==='denied')throw denied();
    if(isJobs&&jobs==='network')throw Object.assign(Error('private network body'),{code:'ECONNREFUSED'});
    return [{id:settings.jobId,cancel:async()=>{},getQueryResults:async()=>[[isJobs?{active_jobs:jobs==='active'?2:0,active_query_jobs:jobs==='active'?2:0,active_load_jobs:0}:{row_count:guard==='duplicate'?2:1,valid_rows:guard==='duplicate'?2:1}],null,{jobComplete:true}]}];
  }};
  const request=async req=>{
    calls.push(req);const u=new URL(req.url);
    assert.ok(req.method==='GET'||u.pathname.endsWith(':getIamPolicy'));
    assert.doesNotMatch(u.pathname,/:setIamPolicy|:testIamPermissions/);
    if(u.hostname==='iam.googleapis.com'){
      if(roleDenied)throw denied();
      return {data:{includedPermissions:u.pathname.includes('logging')?['logging.logEntries.list']:['bigquery.tables.getData','bigquery.tables.create','bigquery.tables.updateData']}};
    }
    if(u.hostname==='cloudresourcemanager.googleapis.com'){
      if(policy==='denied')throw denied();
      if(u.pathname.endsWith(':getIamPolicy'))return {data:{bindings:[{role:'roles/bigquery.dataOwner',members:['serviceAccount:'+(policy==='foreign'?'other@example.invalid':principal)]},...(policy==='conditional'?[{role:'roles/bigquery.dataOwner',members:['serviceAccount:'+principal],condition:{expression:'unverified'}}]:[]),{role:'roles/logging.viewer',members:['group:private-group@example.invalid']}]}};
      return {data:{...(parent?{parent:'organizations/123'}:{})}};
    }
    if(u.pathname.endsWith('/datasets')){
      if(inventory==='denied')throw denied();
      return {data:{datasets:[{datasetReference:{datasetId:'customer_identity'}},{datasetReference:{datasetId:'private_backup'}}]}};
    }
    assert.equal(u.searchParams.get('datasetView'),'FULL');
    return {data:{location:'EU',defaultTableExpirationMs:ttl,access:[{role:grant,userByEmail:principal}]}};
  };
  return {bigquery,request,project:'fixture',principal,calls,outputs,emit:x=>outputs.push(JSON.parse(x))};
}
test('read-only preflight verifies each prerequisite and a concrete restricted candidate without exposing principals',async()=>{
  const f=fixture({parent:true}),r=await preflight(f);
  assert.equal(r.publication_guard.status,'valid');assert.equal(r.project_active_jobs.can_inspect_project_wide,true);
  assert.equal(r.restricted_backup_dataset.destination,'fixture.private_backup');
  assert.equal(r.restricted_backup_dataset.hierarchy_complete,true);
  assert.equal(f.outputs.filter(x=>x.check!=='configuration').length,3);
  assert.doesNotMatch(JSON.stringify(f.outputs),/example.invalid|private provider|credential/);
  const q=f.calls.find(x=>x.query?.includes('JOBS_BY_PROJECT'));
  assert.equal(q.params.preflight_jobs.length,2);assert.doesNotMatch(q.query,/STARTS_WITH|JOBS_BY_USER/);
});
test('missing guard and denied project-wide jobs do not suppress backup evidence',async()=>{
  const r=await preflight(fixture({guard:'missing',jobs:'denied'}));
  assert.equal(r.publication_guard.status,'missing');assert.equal(r.project_active_jobs.status,'unknown');
  assert.deepEqual(r.project_active_jobs.required_permissions,['bigquery.jobs.create','bigquery.jobs.listAll']);
  assert.equal(r.restricted_backup_dataset.destination,'fixture.private_backup');
});
test('denied guard metadata is not absence; malformed or duplicate guards are invalid',async()=>{
  for(const guard of ['denied','partitioned','duplicate']){
    const r=await preflight(fixture({guard}));
    assert.equal(r.publication_guard.status,guard==='denied'?'unknown':'invalid');
    assert.equal(r.project_active_jobs.status,'verified');
  }
});
test('policy or listing denial retains independent actionable evidence and cannot certify a destination',async()=>{
  const r=await preflight(fixture({policy:'denied',inventory:'denied'}));
  assert.equal(r.publication_guard.status,'valid');assert.equal(r.project_active_jobs.status,'verified');
  assert.equal(r.restricted_backup_dataset.destination,null);
  assert.equal(r.restricted_backup_dataset.hierarchy_failure.http_status,403);
  assert.equal(r.restricted_backup_dataset.inventory_failure.http_status,403);
  assert.ok(r.restricted_backup_dataset.required_permissions.includes('resourcemanager.projects.getIamPolicy'));
  assert.ok(r.restricted_backup_dataset.required_permissions.includes('bigquery.datasets.get'));
});
test('foreign/conditional/unresolved inherited roles and expiring backups cannot be selected',async()=>{
  for(const options of [{policy:'foreign'},{policy:'conditional'},{roleDenied:true},{ttl:86400000}]){
    const r=await preflight(fixture(options));
    assert.equal(r.restricted_backup_dataset.destination,null,JSON.stringify(options));
  }
});
test('active jobs are reported independently from verified visibility',async()=>{
  const r=await preflight(fixture({jobs:'active'}));
  assert.equal(r.project_active_jobs.status,'verified');assert.equal(r.project_active_jobs.active_jobs,2);
});
test('a stalled guard metadata read is bounded and does not hide completed job or backup results',async()=>{
  const f=fixture(),dataset=f.bigquery.dataset;
  f.bigquery.dataset=()=>({...dataset(),table:()=>({getMetadata:()=>new Promise(()=>{})})});
  const r=await preflight({...f,maximumMs:100});
  assert.equal(r.publication_guard.status,'unknown');assert.equal(r.publication_guard.failure,'deadline');
  assert.equal(r.project_active_jobs.status,'verified');
  assert.equal(r.restricted_backup_dataset.status,'no_verified_destination');
  assert.equal(r.restricted_backup_dataset.inventory_truncated,true);
  assert.equal(f.outputs.filter(x=>x.check!=='configuration').length,3);
});

test('network failures do not masquerade as missing IAM permission grants',async()=>{
  const r=await preflight(fixture({jobs:'network'}));
  assert.equal(r.project_active_jobs.failure,'network_unavailable');
  assert.equal(r.project_active_jobs.reason,'ECONNREFUSED');
  assert.deepEqual(r.project_active_jobs.required_permissions,[]);
  assert.match(r.project_active_jobs.action,/proxy/);
  assert.equal(r.publication_guard.status,'valid');
});
