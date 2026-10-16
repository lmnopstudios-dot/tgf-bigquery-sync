import { createKlaviyoClient } from './client.js';
import { campaignSendMetadata, metadataPaths } from './metadata.js';

/** Read-only enumeration: never infer actual send ordering from API list order. */
export async function discoverSentCampaigns({env,fetchImpl=fetch,name=null,channel=null,cutoff,account,timezone}) {
  if (channel && channel !== 'email') return {candidates:[],complete:true,source:'Klaviyo email campaign discovery'};
  const client=createKlaviyoClient({apiKey:env.KLAVIYO_PRIVATE_API_KEY,revision:env.KLAVIYO_API_REVISION,fetchImpl,
    maxCalls:24,maxRetries:0,timeoutMs:8000,maxElapsedMs:20000});
  const listing=await client.paginate(metadataPaths.campaign,{maxPages:20,maxItems:2000});
  const retrieved_at=new Date().toISOString();
  const candidates=listing.data.map(item=>{
    if (typeof item?.id!=='string' || !item.id || item.type!=='campaign')
      throw Object.assign(Error('Invalid campaign identity'),{code:'INVALID_CAMPAIGN_METADATA'});
    const a=item.attributes||{};
    return {entity_kind:'campaign',entity_id:item.id,entity_name:a.name||item.id,status:a.status,
      ...campaignSendMetadata(a),account,channel:'email',reporting_timezone:timezone,retrieved_at};
  }).filter(c=>!name||c.entity_id===name||String(c.entity_name).toLowerCase()===name.toLowerCase());
  // Do not discard missing timestamps here: shared selection must see and guard
  // them. A/B variants and multiple messages are one parent campaign. Resends
  // with a distinct parent ID remain distinct; sending is eligible/provisional.
  return {candidates,complete:true,source:'read-only Klaviyo campaigns API',pages:listing.pages,api_calls:client.callCount,selection_cutoff:cutoff};
}

// No provider exception text or private payload enters the staff answer.
export function campaignDiscoveryLimitation(error) {
  if (error?.status === 401 || error?.status === 403)
    return 'I cannot read the Klaviyo campaign list with the configured account credentials. Campaign read access must be restored before I can verify the latest sends. Dates cannot resolve this access issue.';
  if (['PAGINATION_BOUND','ITEM_BOUND','CALL_BOUND','ELAPSED_BOUND'].includes(error?.code))
    return 'The campaign list exceeded the read-only discovery limit, so I cannot verify the latest sends from a complete listing. Campaign names or identifiers can narrow the request; dates cannot establish send ordering.';
  if (error?.status === 429)
    return 'Klaviyo temporarily limited campaign discovery. Retry once campaign read access is available; dates cannot establish the missing send ordering.';
  return 'I cannot verify the latest campaigns because the campaign discovery service is unavailable or its listing is incomplete. Campaign names or identifiers can narrow the request; dates cannot restore send metadata.';
}
