// Only deployment-owned, evidence-backed certificates may establish continuous
// follow-up. Activity endpoints and a public launch date are not certificates.
export function observationCoverage(certificates=[],source,store,timeZone='Europe/London'){
  const matches=certificates.filter(c=>c.source_platform===source&&c.source_store===store);
  if(matches.length>1)throw Error('Conflicting observation coverage');
  const c=matches[0];
  if(!c)return {status:'unverified',start:null,end:null,evidence:null};
  const valid=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&!Number.isNaN(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s;
  if(c.status!=='verified_continuous'||!valid(c.start)||!valid(c.end)||c.start>c.end||typeof c.evidence!=='string'||!c.evidence.trim())throw Error('Invalid observation coverage certificate');
  if(c.time_zone!==timeZone)return {status:'unverified',start:null,end:null,evidence:null};
  return {status:c.status,start:c.start,end:c.end,evidence:c.evidence};
}
export function observationWindow({entry,days,requestedEnd,coverage}){
  const end=new Date(entry+'T00:00:00Z');end.setUTCDate(end.getUTCDate()+days);
  return coverage?.status==='verified_continuous'&&entry>=coverage.start&&end.toISOString().slice(0,10)<=coverage.end&&end.toISOString().slice(0,10)<=requestedEnd;
}
