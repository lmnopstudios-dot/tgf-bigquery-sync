// Broad intent is separate from the supported predicate grammar. A recognised
// catalogue export may fail planning, but must never become a capped tool read.
export function inventoryCatalogueExportIntent(message){
 const t=String(message||'').replace(/[*`]/g,'').replace(/\b(?:do not|don't|no)\s+(?:modify|change|update|adjust)\s+(?:the\s+)?(?:stock|inventory)\b/gi,'');
 if(/^\s*(?:please\s+)?(?:edit|rewrite|proofread|summari[sz]e|translate|save|remember|propose)\b/i.test(t)||/^\s*(?:From:|Subject:|Dear\s|Hi\s)/i.test(t))return false;
 const catalogue=/\b(?:all|every)\s+(?:(?:active|draft|unlisted|archived|product|Shopify|and)\s+)*(?:products?|variants?|items?)\b|\bactive(?:[- ]only)?\s+(?:product\s+)?variants?\b|\b(?:complete|paginated|entire)\s+(?:paginated\s+)?catalog(?:ue)?\b|\beverything\b/i.test(t);
 return catalogue&&/\b(?:stock|inventory|available|POS)\b/i.test(t)&&/\b(?:excel|xlsx|spreadsheet|export|download(?:able)?)\b/i.test(t);
}
export function inventoryScopeError(){return Object.assign(new Error('The catalogue inventory export could not be planned. No capped stock lookup was run.'),{code:'INVALID_INVENTORY_REPORT',failed_stage:'inventory_scope_resolution'});}
export function assertLegacyInventoryAllowed({message,analysisContext}={}){
 if(inventoryCatalogueExportIntent(message)||analysisContext?.inventory_report)throw Object.assign(new Error('Catalogue-wide inventory requires the paginated export pipeline'),{code:'INVENTORY_EXPORT_REQUIRES_REPORT',failed_stage:'inventory_route_guard'});
}
