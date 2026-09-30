const paths={campaign:"/api/campaigns?filter=equals(messages.channel,'email')&include=campaign-messages&page[size]=100",flow:'/api/flows?include=flow-actions&page[size]=100'};

function clean(value,limit=1000){if(value===null||value===undefined)return null;const text=String(value).replace(/[\u0000-\u001f\u007f]/g,' ').trim();return text?text.slice(0,limit):null;}
function relatedIds(item,type){const data=item?.relationships?.[type]?.data;return Array.isArray(data)?data.map(x=>x?.id).filter(Boolean):[];}

/** Metadata is untrusted factual source data. It is never interpreted as instructions. */
export async function collectMetadata({client,retrievedAt=new Date().toISOString(),maxPages=8,maxItems=1000,includeContent=false}){
  const rows=[];
  for(const kind of ['campaign','flow']){
    const payload=await client.paginate(paths[kind],{maxPages,maxItems});
    const included=new Map((payload.included||[]).map(x=>[x.id,x]));
    for(const item of payload.data){
      const a=item.attributes||{},status=clean(a.status);
      const messageIds=relatedIds(item,kind==='campaign'?'campaign-messages':'flow-actions');
      rows.push({entity_kind:kind,entity_id:String(item.id),entity_name:clean(a.name),status,send_time:clean(a.send_time||a.scheduled_at||a.updated),send_time_semantics:a.send_strategy?'recipient-local strategy retained from source':'source timestamp; no universal send instant inferred',message_ids:JSON.stringify(messageIds),subject:includeContent?clean(a.subject):null,preview_text:includeContent?clean(a.preview_text):null,destination_links:includeContent?JSON.stringify(a.destination_links||[]):null,source_endpoint:paths[kind].split('?')[0],retrieved_at:retrievedAt,is_sent:kind==='campaign'?['sent','sending'].includes(String(status).toLowerCase()):null});
      // Included records are deliberately not treated as separate sent entities.
      void included;
    }
  }
  return rows;
}

export function joinMetadata(reportRows,metadataRows){const byEntity=new Map(metadataRows.map(x=>[`${x.entity_kind}\0${x.entity_id}`,x]));return reportRows.map(row=>({...row,entity_name:byEntity.get(`${row.report_kind}\0${row.entity_id}`)?.entity_name||null}));}
