import { validateAnalysisContext } from './analysis-context.js';
const esc=value=>String(value||'unavailable').replaceAll('\n',' ').replaceAll('|','\\|');
const day=(instant,zone)=>new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(instant));
export async function resolveCampaignContext(context,provider){
  const request=structuredClone(context.campaign_request);
  const pending=answer=>({answer,tools:[],analysis_context:validateAnalysisContext({...context,campaign_request:request}),clarification:true});
  const missing=()=>{const asked=request.clarification_attempted;request.clarification_attempted=true;return pending(asked?'The supplied clarification is retained, but governed send metadata still cannot verify the campaign. Campaign attribution is unavailable for now.':'Campaign send metadata is unavailable. Please provide the campaign name or send date. I’ll retain the requested campaign attribution metrics.');};
  if(!request.selected&&!request.metadata_attempted){
    request.metadata_attempted=true;
    let result;
    try{result=await provider.resolveCampaigns({name:request.selector==='named'?request.name:null,channel:request.channel,cutoff:request.cutoff});}catch{
      return missing();
    }
    let candidates=(result.candidates||[]).filter(c=>c.entity_id&&c.entity_kind!=='flow'&&c.report_kind!=='flow'&&!(c.send_time_semantics==='actual campaign send timestamp'&&Date.parse(c.send_time)>Date.parse(request.cutoff))&&(!request.channel||c.channel===request.channel)&&c.channel!=='flow'&&(!c.status||['sent','sending'].includes(c.status.toLowerCase()))&&c.is_sent!==false);
    candidates=candidates.map(c=>({...c,send_time:c.send_time_semantics==='actual campaign send timestamp'&&!Number.isNaN(Date.parse(c.send_time))&&Date.parse(c.send_time)<=Date.parse(request.cutoff)?c.send_time:null}));
    if(request.selector==='latest'&&candidates.every(c=>c.send_time)){
      const groups=new Map();for(const c of candidates){const key=`${c.account}/${c.channel}`,previous=groups.get(key)||[];if(!previous.length||Date.parse(c.send_time)>Date.parse(previous[0].send_time))groups.set(key,[c]);else if(Date.parse(c.send_time)===Date.parse(previous[0].send_time))previous.push(c);}candidates=[...groups.values()].flat();
    }
    request.candidates=candidates.slice(0,50);
    if(result.complete!==false&&candidates.length===1)request.selected=candidates[0];
    else if(candidates.length)return pending(`Which sent campaign do you mean?${result.complete===false?' The metadata listing is incomplete; please identify a campaign.':''}\n\n${request.candidates.map((c,i)=>`${i+1}. ${esc(c.entity_name)} (ID ${esc(c.entity_id)}; account ${esc(c.account)}; ${esc(c.channel)}; sent ${esc(c.send_time)}; timezone ${esc(c.reporting_timezone)})`).join('\n')}`);
    else return missing();
  }
  if(!request.selected){
    // Never repeat the date question when a name/date has already been supplied.
    return pending(request.send_date?'The send date is retained, but no campaign identity is supported by the available metadata. Campaign-attributed counts are unavailable until that identity can be verified.':'Please select an identifiable campaign from the retained candidates, or provide its name.');
  }
  const c=request.selected;
  if(request.date_mode!=='since_send'&&!context.start_date)return pending(`What date range would you like for ${esc(c.entity_name)} (ID ${esc(c.entity_id)}, ${esc(c.account)}, ${esc(c.channel)})? You can use the campaign’s send date.`);
  if(request.date_mode==='since_send'){
    if(!c.send_time&&!request.send_date)return missing();
    const timezone=c.reporting_timezone||'Europe/London',start=request.send_date||day(c.send_time,timezone),runtime=day(request.cutoff,timezone),end=c.reporting_cutoff&&c.reporting_cutoff<runtime?c.reporting_cutoff:runtime;
    if(!c.reporting_cutoff)return pending('The campaign identity is retained, but no supported reporting cutoff is available. Attribution cannot be reported for this range yet.');
    if(start>end)return pending(`The campaign was sent after the supported reporting cutoff (${end}, ${timezone}). No post-send attribution evidence is available yet.`);
    return {context:validateAnalysisContext({...context,start_date:start,end_date:end,campaign_request:request,date_cutoff:end,current_day_included:end===runtime,unresolved_required_fields:[]})};
  }
  return {context:validateAnalysisContext({...context,campaign_request:request})};
}
