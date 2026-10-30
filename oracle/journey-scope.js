// Opt-in reporting contract. Null retains the accepted legacy report verbatim.
export const JOURNEY_SCOPE_VERSION='square_channels_v1';
export const JOURNEY_CHANNELS=['all','online','instore'];
export function validateJourneyScope(value){
 if(value==null)return null;
 if(typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='entry,followup,include_square,next,version'||value.version!==JOURNEY_SCOPE_VERSION||typeof value.include_square!=='boolean'||!JOURNEY_CHANNELS.includes(value.entry)||!JOURNEY_CHANNELS.includes(value.followup)||!['anywhere_then_filter','next_matching_channel'].includes(value.next))throw Error('Invalid journey channel scope');
 return {...value};
}
export function channelValue(value){return value==='online'?'Online':value==='instore'?'In-store':null;}
export function journeyScopeDefinition(c){
 const scope=validateJourneyScope(c.journey_scope);
 return scope?{report_scope:scope,cohort:{entry_channel:channelValue(scope.entry)},subsequent:{channel:channelValue(scope.followup)}}:null;
}
export function journeyScopeText(scope){
 if(!scope)return '';
 const label=x=>x==='all'?'All supported channels (unknown channel retained)':x==='online'?'Online only':'In-store only (supported provenance)';
 return `Entry-purchase channel: ${label(scope.entry)}. Follow-up purchase channel: ${label(scope.followup)}. ${scope.next==='anywhere_then_filter'?'Select the next strictly later eligible purchase anywhere, then test its channel; an intervening purchase is never skipped.':'Select the next strictly later eligible purchase matching the follow-up channel; intervening purchases in other channels may be skipped.'} ${scope.include_square?'Square extension requested.':'Square excluded.'} Combined eligible history is sequenced before either filter.`;
}
// Parse channel roles rather than assigning both to a single word. Explicit
// roles override a common-channel selection; unspecified roles remain 'all'.
export function requestedJourneyScope(text,previous=null){
 const s=String(text),old=validateJourneyScope(previous);
 const channel='(online|in[ -]?store|anywhere|all supported channels|all channels)';
 const val=x=>/online/i.test(x)?'online':/in[ -]?store/i.test(x)?'instore':'all';
 const entry=s.match(new RegExp('(?:entry(?:[- ]purchase)?(?: channel)?|first(?:[- ]observed)? purchases?|introduced|customers introduced)\\s*(?::|=|in|from)?\\s*'+channel,'i'))||s.match(new RegExp(channel+'\\s+(?:first(?:[- ]observed)? purchases?|entry purchases?)','i'));
 const follow=s.match(new RegExp('(?:follow[- ]?up(?: purchase)?(?: channel)?|followed by|then(?: purchases?)?|next purchase(?: anywhere)?(?: if)?|buy next)\\s*(?::|=|in)?\\s*'+channel,'i'));
 const square=/\b(?:include|including|with) Square\b|\bSquare (?:included|extension)\b/i.test(s),without=/\b(?:exclude|excluding|without|disable) Square\b/i.test(s);
 const common=s.match(/\b(all supported channels|all channels|online only|just online|in[ -]?store only)\b/i);
 const mode=/\bnext (?:in[ -]?store|online) (?:purchase|order)\b|\bnext matching(?: channel)?\b/i.test(s)?'next_matching_channel':/\bnext (?:purchase|order) anywhere\b|\banywhere[, ]+(?:if|then)|\banywhere then filter\b/i.test(s)?'anywhere_then_filter':null;
 // Legacy 'online only' continues to use its accepted contract unless the
 // versioned controls, Square or channel roles have been explicitly requested.
 if(!old&&!entry&&!follow&&!square&&!without&&!mode&&!/all supported channels/i.test(s))return null;
 const out={version:JOURNEY_SCOPE_VERSION,include_square:old?.include_square||false,entry:old?.entry||'all',followup:old?.followup||'all',next:old?.next||'anywhere_then_filter'};
 if(common){out.entry=val(common[1]);out.followup=val(common[1]);}
 if(entry)out.entry=val(entry.at(-1));
 if(follow)out.followup=val(follow.at(-1));
 const nextChannel=s.match(/\bnext (in[ -]?store|online) (?:purchase|order)\b/i);if(nextChannel)out.followup=val(nextChannel[1]);
 const anywhereIf=s.match(/\bnext (?:purchase|order) anywhere[, ]+(?:if|then)\s*(?:it is |it was |in )?(in[ -]?store|online)\b/i);if(anywhereIf)out.followup=val(anywhereIf[1]);
 if(square)out.include_square=true;if(without)out.include_square=false;if(mode)out.next=mode;
 return validateJourneyScope(out);
}
export function assertJourneyScopeEvidence(context,evidence){
 const wanted=validateJourneyScope(context.journey_scope),actual=validateJourneyScope(evidence.definition?.report_scope);
 if(JSON.stringify(wanted&&Object.fromEntries(Object.entries(wanted).sort()))!==JSON.stringify(actual&&Object.fromEntries(Object.entries(actual).sort())))throw Error('Journey channel evidence scope mismatch');
 if(wanted&&!Array.isArray(evidence.reporting_coverage))throw Error('Journey channel coverage unavailable');
 if(!wanted?.include_square&&evidence.identity_evidence?.reporting_extension)throw Error('Unrequested Square extension evidence');
 if(wanted?.include_square){
  const x=evidence.identity_evidence?.reporting_extension;
  if(x?.version!==JOURNEY_SCOPE_VERSION||x.identity_version!=='square_native_email_v1'||(x.state==='reviewed'&&!/^[A-Za-z0-9_-]{1,100}$/.test(x.id||''))||x.base_snapshot!==evidence.identity_evidence.snapshot||!['reviewed','preview'].includes(x.state)||!evidence.reporting_coverage)throw Error('Square extension evidence unavailable');
 }
}
export function applyJourneyScopeDefinition(definition,context){
 const x=journeyScopeDefinition(context);
 return x?{...definition,report_scope:x.report_scope,cohort:{...definition.cohort,...x.cohort},subsequent:{...definition.subsequent,...x.subsequent}}:definition;
}
export const JOURNEY_SCOPE_LIMITATION='Square and cross-platform email matches are analytical candidates, not verified people. Unmatched source-local histories are retained; Square orders without unambiguous native IDs are reported in coverage and excluded from customer cohorts; they cannot establish customer repeat purchases. The linked subset is not representative of all retail customers. Residual undocumented imports/cross-platform duplicates, incomplete prior history and follow-up remain unverified. Unknown channels participate in full-history sequencing but do not satisfy online or supported in-store filters. Missing product mappings/classifications remain unknown; titles never establish collaboration membership.';
export function reportingCoverageText(rows=[]){
 if(!Array.isArray(rows)||rows.length>500)throw Error('Invalid reporting coverage');
 return rows.map(r=>{
  const keys=['eligible_orders','analytical_records','anonymous_orders','orders_without_lines','product_lines','mapped_lines','ambiguous_lines','named_lines','eligible_transaction_orders','unidentifiable_orders','native_conflict_orders'];
  if(!['woo','shopify','square'].includes(r.source_platform)||!['ww','usd','shopify','square'].includes(r.source_store)||!['Online','In-store','Unknown'].includes(r.channel)||!keys.every(k=>r[k]!=null&&r[k]!==''&&typeof r[k]!=='boolean'&&Number.isSafeInteger(Number(r[k]))&&Number(r[k])>=0)||Number(r.mapped_lines)>Number(r.product_lines)||Number(r.ambiguous_lines)>Number(r.product_lines)||Number(r.named_lines)>Number(r.product_lines)||!Number.isInteger(Number(r.year))||Number(r.year)<1||Number(r.year)>9999||Number(r.analytical_records)>Number(r.eligible_orders)||Number(r.anonymous_orders)>Number(r.eligible_orders)||Number(r.orders_without_lines)>Number(r.eligible_orders)||Number(r.eligible_orders)>Number(r.eligible_transaction_orders)||Number(r.unidentifiable_orders)>Number(r.eligible_transaction_orders)||Number(r.native_conflict_orders)>Number(r.unidentifiable_orders))throw Error('Invalid reporting coverage');
  return `${r.source_platform}/${r.source_store}, ${r.channel}, ${r.year}: ${r.eligible_orders} customer-history orders / ${r.eligible_transaction_orders} eligible transaction orders; ${r.unidentifiable_orders} unidentifiable Square orders excluded, ${r.native_conflict_orders} with conflicting native IDs (overlapping); ${r.anonymous_orders} anonymous online records; ${r.orders_without_lines} orders without lines; ${r.mapped_lines}/${r.product_lines} product lines with approved identity/family mappings; ${r.ambiguous_lines} ambiguous lines; ${r.named_lines} governed named-collaboration lines. Endpoints do not verify continuity.`;
 });
}
export function journeyReportContract(base,scope){
 return scope?{...base,reporting_version:JOURNEY_SCOPE_VERSION,identity_extension:scope.include_square?'square_native_email_v1':null,primary:scope.next==='next_matching_channel'?'next_matching_channel_order_by_cutoff':'next_eligible_order_by_cutoff'}:base;
}
