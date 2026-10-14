const MONTHS=['january','february','march','april','may','june','july','august','september','october','november','december'];
const valid=d=>/^\d{4}-\d{2}-\d{2}$/.test(d||'')&&Number.isFinite(Date.parse(d))&&new Date(d+'T00:00:00Z').toISOString().slice(0,10)===d;
export const explicitKnowledgeSaveIntent=text=>/^(?:please\s+)?(?:save|remember|record|store)\b(?![\s\S]*\b(?:xlsx|spreadsheet|workbook|csv|pdf)\b)|\b(?:save|record|remember|store|add)\b[\s\S]*\b(?:definition|policy|rule|knowledge|record|fact|event)\b|\b(?:save|remember|record) (?:this|that|it)\b|\b(?:propose|create|write)\b[\s\S]*\b(?:timeless|operational|governed)\s+definition\b/i.test(String(text).replace(/\bonline store\b/gi,'online channel'));
export function pendingClarificationKind(c){
  if(c.promotion_context?.pending_dates||c.promotion_context?.pending_endpoint)return 'promotion';
  if(c.pending_product_candidates?.length&&!c.product_ref)return 'product_selection';
  if(c.campaign_request?.selected_entities?.length)return c.campaign_request.candidates?.length?'campaign':null;
  if(c.campaign_request&&(!c.start_date||!c.end_date)||c.campaign_request?.candidates?.length||c.campaign_request?.metadata_attempted&&(!c.campaign_request.selected||!c.campaign_request.selected.send_time))return 'campaign';
  if(c.product_report?.unresolved?.length||c.product_report?.catalogue_filter&&c.product_report.catalogue_filter.source==null)return 'product_report';
  if(c.unresolved_required_fields?.length)return 'scope';
  return null;
}
function calendarRange(text,reference){
  const year=reference?.slice(0,4);if(!year)return null;
  const monthPattern=MONTHS.map(m=>m.slice(0,3)+'(?:'+m.slice(3)+')?').join('|');
  const iso=text.match(/\b(20\d{2}-\d{2}-\d{2})\s*(?:to|through|until|[-–—])\s*(20\d{2}-\d{2}-\d{2})\b/i);
  const named=text.match(new RegExp(`\\b(\\d{1,2})(?:\\s+(${monthPattern}))?(?:\\s+(20\\d{2}))?\\s*(?:to|through|until|[-–—])\\s*(\\d{1,2})\\s+(${monthPattern})(?:\\s+(20\\d{2}))?\\b`,'i'));
  const make=(d,m,y)=>`${y}-${String(MONTHS.findIndex(n=>n.startsWith(m.toLowerCase()))+1).padStart(2,'0')}-${d.padStart(2,'0')}`;
  let start,end;
  if(iso)[,start,end]=iso;
  else if(named){start=make(named[1],named[2]||named[5],named[3]||named[6]||year);end=make(named[4],named[5],named[6]||named[3]||year);}
  else return null;
  return valid(start)&&valid(end)&&start<=end?{start_date:start,end_date:end}:{invalid:true};
}
/** Consume only an answer compatible with active pending fields. New subjects
 * and explicit knowledge-save commands continue through their existing routes. */
export function consumePendingClarification(c,text){
  if(explicitKnowledgeSaveIntent(text)||/^(?:new (?:question|analysis)|forget that|start over)\b/i.test(text))return null;
  const kind=pendingClarificationKind(c)||(c.promotion_context?.calendar_instruction&&/\b(?:exclude|excluding|omit|remove|leave out|inclusive)\b/i.test(text)||c.promotion_context?.endpoint_zone&&/\b(?:use|timezone|time zone|in|as)\s+(?:GMT|UTC|BST)\b/i.test(text)?'promotion':null);
  if(kind==='promotion'){
    const p=c.promotion_context,reference=p.pending_endpoint_date||c.start_date;
    if(/\b(?:exclude|excluding|omit|remove|leave out|comparison|baseline|inclusive|sale days?)\b/i.test(text)){
      const range=calendarRange(text,reference);
      if(range?.invalid)return {kind,context:c,rejected:'That exclusion range contains an invalid or reversed date. Provide valid inclusive comparison dates; the existing analytical window and treatment are retained.'};
      if(range)return {kind,context:{...c,promotion_context:{...p,treatment:'compare_excluding',supplied_periods:[range],calendar_instruction:text.slice(0,2000),pending_dates:false,pending_endpoint:false,endpoint_choice:null}}};
    }
    const zone=text.match(/\b(?:use|timezone|time zone|in|as)\s+(GMT|UTC|BST)\b/i)?.[1]?.toUpperCase();
    if(zone)return {kind,context:{...c,promotion_context:{...p,endpoint_zone:zone,...(/\b(?:end|start|beginning) of (?:the |that )?day\b/i.test(text)?{endpoint_choice:/\bend of\b/i.test(text)?'end_of_day':'start_of_day',pending_dates:false,pending_endpoint:false}:{})}}};
  }
  if(kind==='product_selection'&&c.requested_subject==='product_sales'){
    const ordinal=text.match(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth)\b/i),number=text.match(/^(?:(?:use|choose|pick|select)\s+)?(?:(?:the\s+)?(?:option|choice|candidate|number)\s+)?#?(\d+)\s*[.!]?$/i);
    const index=number?Number(number[1])-1:ordinal?['first','second','third','fourth','fifth','sixth','seventh','eighth'].indexOf(ordinal[1].toLowerCase()):-1;
    const clean=text.replace(/^(?:use|choose|pick|select)\s+(?:the\s+)?/i,'').replace(/[.!]$/,'').toLowerCase();
    const matches=c.pending_product_candidates.filter(x=>x.product_ref.toLowerCase()===clean||x.catalogue_titles.some(t=>t.toLowerCase()===clean)||x.sources.some(s=>s.source_product_ref.toLowerCase()===clean));
    const candidate=matches.length===1?matches[0]:index>=0?c.pending_product_candidates[index]:null;
    if(candidate)return {kind,context:{...c,product_ref:candidate.product_ref}};
  }
  return null;
}
export function suppressAnalyticalProposals(context,transition,message){
  if(explicitKnowledgeSaveIntent(message))return false;
  const text=String(message).replace(/^(?:new (?:question|analysis)|forget that|start over)\s*[:,.]?\s*/i,'');
  const instruction=/^(?:please\s+)?(?:show|give|compare|graph|chart|export|download|retry|try again|use|choose|pick|select|include|exclude|excluding|omit|remove|leave out|sort|rank|by|only|just|account for|since|from|which|what|how|can you|could you)\b/i.test(text);
  const fieldAnswer=/^(?:20\d{2}-\d{2}-\d{2}|\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|GBP|USD|EUR|JPY|online|in[ -]store|units sold|product sales|landing(?:-page)? sessions|organic clicks|organic impressions)\b/i.test(text);
  const consumed=transition?.clarification_consumed&&(transition.clarification_consumed!=='scope'||instruction||fieldAnswer);
  return Boolean(context?.tool_route==='get_order_value_analysis'||consumed||transition?.applies_to_message&&context?.requested_subject&&context?.request_kind!=='knowledge_save'&&instruction);
}
