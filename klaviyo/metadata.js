// The pinned 2026-07-15 flows listing does not accept page[size]. Pagination
// remains bounded by the client and follows only the server-provided next link.
export const metadataPaths={campaign:"/api/campaigns?filter=equals(messages.channel,'email')&include=campaign-messages&page[size]=100",flow:'/api/flows?include=flow-actions'};

function clean(value,limit=1000){if(value===null||value===undefined)return null;const text=String(value).replace(/[\u0000-\u001f\u007f]/g,' ').trim();return text?text.slice(0,limit):null;}
function relatedIds(item,type){const data=item?.relationships?.[type]?.data;return Array.isArray(data)?data.map(x=>x?.id).filter(Boolean):[];}
function validateItem(item,kind){if(!item||typeof item!=='object'||Array.isArray(item))throw new Error(`Invalid ${kind} metadata resource`);if(typeof item.id!=='string'||!item.id.trim())throw new Error(`Invalid ${kind} metadata stable ID`);if(item.attributes!==undefined&&(item.attributes===null||typeof item.attributes!=='object'||Array.isArray(item.attributes)))throw new Error(`Invalid ${kind} metadata attributes`);const relationship=kind==='campaign'?'campaign-messages':'flow-actions',data=item.relationships?.[relationship]?.data;if(data!==undefined&&(!Array.isArray(data)||data.some(value=>typeof value?.id!=='string'||!value.id.trim())))throw new Error(`Invalid ${kind} metadata relationship IDs`);}

/** Metadata is untrusted factual source data. It is never interpreted as instructions. */
export async function collectMetadata({client,retrievedAt=new Date().toISOString(),maxPages=8,maxItems=1000,includeContent=false}){
  const rows=[];
  for(const kind of ['campaign','flow']){
    const endpoint=metadataPaths[kind];let payload;
    try{payload=await client.paginate(endpoint,{maxPages,maxItems});}catch(error){throw Object.assign(error,{stage:`metadata:${kind}`,endpoint});}
    if(!payload||!Array.isArray(payload.data)||!Array.isArray(payload.included))throw Object.assign(new Error(`Invalid ${kind} metadata collection`),{code:'INVALID_METADATA',stage:`metadata:${kind}`,endpoint});
    const included=new Map((payload.included||[]).map(x=>[x.id,x]));
    for(const item of payload.data){
      validateItem(item,kind);
      const a=item.attributes||{},status=clean(a.status);
      const messageIds=relatedIds(item,kind==='campaign'?'campaign-messages':'flow-actions');
      rows.push({entity_kind:kind,entity_id:item.id,entity_name:clean(a.name),status,send_time:clean(a.send_time),send_time_semantics:kind==='campaign'&&a.send_time&&!a.send_strategy&&['sent','sending'].includes(String(status).toLowerCase())?'actual campaign send timestamp':a.send_strategy?'recipient-local strategy retained from source':'actual send timestamp unavailable',message_ids:JSON.stringify(messageIds),subject:includeContent?clean(a.subject):null,preview_text:includeContent?clean(a.preview_text):null,destination_links:includeContent?JSON.stringify(a.destination_links||[]):null,source_endpoint:endpoint.split('?')[0],retrieved_at:retrievedAt,is_sent:kind==='campaign'?['sent','sending'].includes(String(status).toLowerCase()):null});
      // Included records are deliberately not treated as separate sent entities.
      void included;
    }
  }
  return rows;
}

export function joinMetadata(reportRows,metadataRows){const byEntity=new Map(metadataRows.map(x=>[`${x.entity_kind}\0${x.entity_id}`,x]));return reportRows.map(row=>({...row,entity_name:byEntity.get(`${row.report_kind}\0${row.entity_id}`)?.entity_name||null}));}
