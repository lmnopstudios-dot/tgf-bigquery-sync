// Only source-native structured metadata is eligible. Titles are never classification.
export const categoryToken=value=>String(value||'').trim().toLowerCase().replace(/[ _-]+/g,' ').replace(/\b(pendant|ring|earring)s\b/g,'$1');
export function selectCataloguePopulation(catalogue,config){
  const filter=config.catalogue_filter;
  if(!filter)return {catalogue:{...catalogue,products:catalogue.products.filter(p=>!config.population.product_ids||config.population.product_ids.includes(p.product_id))},selection:{contract_version:2,filter:null,matching_product_ids:catalogue.products.filter(p=>!config.population.product_ids||config.population.product_ids.includes(p.product_id)).map(p=>p.product_id)}};
  if(!catalogue.complete)return {clarification:`I could not inspect the complete Shopify catalogue for “${filter.term}”. Please retry; no category export was created.`};
  const candidates=new Map(),term=categoryToken(filter.term);
  for(const p of catalogue.products){
    const values=[['product_type',p.product_type],...(p.tags||[]).map(t=>['tag',t]),...(p.collections||[]).flatMap(c=>[['collection',c.title,c.id],['collection',c.handle,c.id],['collection',c.id,c.id]])];
    for(const [source,value,collectionId] of values){if(filter.source&&filter.source!==source||categoryToken(value)!==term)continue;
      const key=`${source}:${collectionId||term}`,candidate=candidates.get(key)||{source,value:String(value),...(collectionId?{collection_id:collectionId}:{}),ids:new Set()};candidate.ids.add(p.product_id);candidates.set(key,candidate);
    }
  }
  const choices=[...candidates.values()],populations=new Set(choices.map(c=>JSON.stringify([...c.ids].sort())));
  if(!choices.length)return {clarification:`I found no Shopify collection, product type or tag matching “${filter.term}”. Which available classification should I use? No export was created.`};
  if(populations.size>1)return {clarification:`“${filter.term}” matches different Shopify populations. Which should I use? ${choices.map(c=>`${c.source.replace('_',' ')} “${c.value}” (${c.ids.size} products${c.collection_id?`, ID ${c.collection_id}`:''})`).join('; ')}. Reply “Use product type ${filter.term}”, “Use collection ${filter.term}” or “Use tag ${filter.term}”.`};
  const ids=choices[0].ids;
  let readyIds=null,readyBindings=[];
  if(filter.ready_to_ship){
    const ready=selectCataloguePopulation(catalogue,{...config,population:{...config.population,product_ids:null},catalogue_filter:{term:'ready-to-ship',source:null}});
    if(ready.clarification)return ready;
    readyIds=new Set(ready.selection.matching_product_ids);readyBindings=ready.selection.bindings;
  }
  const products=catalogue.products.filter(p=>ids.has(p.product_id)&&(!readyIds||readyIds.has(p.product_id))&&(!config.population.product_ids||config.population.product_ids.includes(p.product_id)));
  return {catalogue:{...catalogue,products},selection:{contract_version:2,filter,bindings:choices.map(({ids,...c})=>c),ready_to_ship_bindings:readyBindings,matching_product_ids:products.map(p=>p.product_id)}};
}

export function assertCatalogueSelection(evidence,config){
  const fail=()=>{throw Object.assign(new Error('Export population does not agree with resolved catalogue selection'),{code:'EVIDENCE_SCOPE_MISMATCH',failed_stage:'evidence_validation'});};
  const selection=evidence?.catalogue_selection;
  if(!config.catalogue_filter&&!selection)return true; // Existing unfiltered downloads remain supported.
  if(selection?.contract_version!==2||JSON.stringify(selection.filter)!==JSON.stringify(config.catalogue_filter)||!Array.isArray(selection.matching_product_ids)||!Array.isArray(evidence.rows))return fail();
  const ids=new Set(selection.matching_product_ids);
  if(ids.size!==selection.matching_product_ids.length||evidence.population_count!==ids.size||evidence.manifest?.row_count!==evidence.rows.length||new Set(evidence.rows.map(p=>p.product_id)).size!==evidence.rows.length||evidence.rows.some(p=>!ids.has(p.product_id))||evidence.rows.length!==(config.population.limit?Math.min(config.population.limit,ids.size):ids.size))return fail();
  if(config.catalogue_filter){
    const matches=(p,bindings)=>Array.isArray(bindings)&&bindings.length>0&&bindings.some(b=>{
      const values=b.source==='product_type'?[p.product_type]:b.source==='tag'?p.tags||[]:b.source==='collection'?(p.collections||[]).filter(c=>!b.collection_id||c.id===b.collection_id).flatMap(c=>[c.title,c.handle,c.id]):[];
      return values.some(value=>categoryToken(value)===categoryToken(b.value));
    });
    if(evidence.rows.some(p=>!matches(p,selection.bindings)||config.catalogue_filter.ready_to_ship&&!matches(p,selection.ready_to_ship_bindings)))return fail();
  }
  return true;
}
