import test from 'node:test';
import assert from 'node:assert/strict';
import { applyProductFamilies, approvedMappingEdges, assertFamilyAssignment, buildHistoricalReviewQueue, buildProductChoicePreview, buildProductMappingCoverage, candidateDiagnostics, classifyProduct, createProductMappingService, generateMappingCandidates, isShopifyParentProduct, productMoneyContract, productSourceLabel, resolveFamilyDecisions, resolveMappingDecisions, sanitizeReviewerNote, searchProducts, suggestShopifyParents, validateGraphApproval } from '../oracle/product-mapping.js';
import { buildCanonicalProductGraph, mapProductPair } from '../oracle/product-identity.js';

const p=(ref,title,extra={})=>({source_product_ref:ref,source_platform:ref.split(':')[0],source_store:ref.split(':')[1],source_product_id:ref.split(':')[2],title,...extra});

test('and/ampersand and shortened titles become generic review candidates',()=>{
  const candidates=generateMappingCandidates([p('woo:ww:1','Love and Death Ring'),p('square:square:2','Love & Death Ring'),p('woo:ww:3','Double Headed Open Skull Band'),p('square:square:4','Double Headed Open Band')]);
  assert.equal(candidates.find(x=>x.left_ref.endsWith(':1'))?.confidence,'high');
  assert.ok(candidates.some(x=>x.left_ref.endsWith(':3')&&x.right_ref.endsWith(':4')));
});

test('competing candidates remain visible and are never automatically selected',()=>{
  const candidates=generateMappingCandidates([p('woo:ww:1','Skull Ring'),p('square:square:2','Silver Skull Ring'),p('shopify:shopify:3','Heavy Skull Ring')]);
  assert.ok(candidates.length>1); assert.ok(candidates.every(x=>x.status==='suggested'&&x.competing));
  assert.equal(approvedMappingEdges(candidates).length,0);
});

test('approval creates an audited explicit edge with highest mapping precedence',()=>{
  const decision={left_ref:'woo:ww:1',right_ref:'shopify:shopify:2',status:'approved',reviewed_by:'admin',reviewed_at:'2026-01-01',provenance:'review'};
  const [edge]=approvedMappingEdges([decision]); assert.equal(edge.mapping_method,'explicit_governed_mapping'); assert.equal(edge.approved_by,'admin');
  assert.equal(mapProductPair([p(decision.left_ref,'Old')],[p(decision.right_ref,'New')],{explicitMappings:[edge]})[0].mapping_method,'explicit_governed_mapping');
});

test('suggestions do not alter canonical graph; approved edges do',()=>{
  const products=[p('woo:ww:1','Bat Ring'),p('square:square:2','Bat Rings')]; const [candidate]=generateMappingCandidates(products,{minimumScore:.4});
  assert.equal(buildCanonicalProductGraph(products,[]).length,2);
  assert.equal(buildCanonicalProductGraph(products,approvedMappingEdges([{...candidate,status:'approved'}])).length,1);
});

test('rejection suppresses reuse and ready-to-ship remains candidate-only',()=>{
  const products=[p('woo:ww:1','Ready To Ship - Alphabones - A'),p('shopify:shopify:2','Alphabones')];
  const [candidate]=generateMappingCandidates(products,{minimumScore:.3}); assert.equal(candidate.candidate_evidence.ready_to_ship_prefix,true);
  assert.equal(generateMappingCandidates(products,{minimumScore:.3,decisions:[{...candidate,status:'rejected'}]}).length,0);
});

test('non-products are conservatively classified and excluded',()=>{
  assert.equal(classifyProduct('UK POSTAGE'),'shipping'); assert.equal(classifyProduct('RESIZE'),'service'); assert.equal(classifyProduct('Gift Voucher £50'),'gift_voucher');
  assert.equal(generateMappingCandidates([p('woo:ww:1','UK POSTAGE'),p('square:square:2','UK Postage')]).length,0);
});

test('approval refuses impossible same-namespace graph collisions',()=>{
  assert.throws(()=>validateGraphApproval({left_ref:'woo:ww:2',right_ref:'square:square:9'},[{left_ref:'woo:ww:1',right_ref:'square:square:9',status:'approved'}]),/conflict/);
});

test('eligibility excludes resolved, shipping, and service products',()=>{
  const products=[p('woo:ww:1','Moon Ring',{mapping_status:'resolved'}),p('square:square:2','Moon Ring'),p('woo:ww:3','Shipping'),p('square:square:4','Shipping'),p('woo:ww:5','Resize Service'),p('square:square:6','Resize Service')];
  assert.equal(generateMappingCandidates(products).length,0);
});

test('candidate normalization handles punctuation and apostrophes without authorizing an edge',()=>{
  const [candidate]=generateMappingCandidates([p('woo:usd:1',"Death's-Head Ring"),p('shopify:shopify:2','Death’s Head Ring')]);
  assert.equal(candidate.confidence,'high');
  assert.match(candidate.candidate_evidence.summary.join(' '),/equivalent title/);
  assert.equal(candidate.status,'suggested');
});

test('containment exposes one meaningful missing token at lower priority',()=>{
  const [candidate]=generateMappingCandidates([p('woo:ww:1','Double Headed Open Skull Band'),p('square:square:2','Double Headed Open Band')]);
  assert.equal(candidate.confidence,'medium');
  assert.deepEqual(candidate.candidate_evidence.unmatched_tokens,['skull']);
});

test('blocking stays bounded and priorities cover high medium and low',()=>{
  const unrelated=Array.from({length:100},(_,i)=>p(`woo:ww:${i}`,`Unique${i} Ring`));
  const diagnostics={};
  const candidates=generateMappingCandidates([...unrelated,p('square:square:x','Unique1 Ring')],{diagnostics,minimumScore:.1});
  assert.ok(diagnostics.blocked_candidate_pairs_considered < 20);
  assert.equal(candidates[0].confidence,'high');
  assert.equal(generateMappingCandidates([p('woo:ww:a','Heavy Silver Skull Ring'),p('square:square:b','Heavy Skull Ring')])[0].confidence,'medium');
  assert.equal(generateMappingCandidates([p('woo:ww:a','Heavy Silver Skull Ring'),p('square:square:b','Silver Skull Pendant')],{minimumScore:.4})[0].confidence,'low');
});

test('approved and rejected decisions suppress candidates and diagnostics retain counts',()=>{
  const products=[p('woo:ww:1','Skull Ring'),p('square:square:2','Silver Skull Ring')];
  const [candidate]=generateMappingCandidates(products);
  const rejected={...candidate,status:'rejected'};
  assert.equal(candidateDiagnostics(products,[rejected]).candidate_count,0);
  assert.equal(candidateDiagnostics(products,[rejected]).rejected_count,1);
  const approved={...candidate,status:'approved'};
  assert.equal(candidateDiagnostics(products,[approved]).eligible_products,0);
  assert.equal(candidateDiagnostics(products,[approved]).approved_count,1);
});

test('current-state resolver follows immutable supersession chains and removes revoked edges',()=>{
  const approval={decision_id:'a',relationship_id:'pair',left_ref:'woo:ww:1',right_ref:'square:square:2',status:'approved',reviewed_at:'2026-01-01'};
  const revocation={decision_id:'b',relationship_id:'pair',left_ref:approval.left_ref,right_ref:approval.right_ref,status:'revoked',supersedes_decision_id:'a',reviewed_at:'2026-01-02'};
  const state=resolveMappingDecisions([revocation,approval]);
  assert.equal(state.history.length,2); assert.equal(state.activeApproved.length,0); assert.equal(state.revoked.length,1); assert.equal(state.superseded[0].decision_id,'a');
  assert.equal(approvedMappingEdges([approval,revocation]).length,0);
});

test('replacement enters canonical graph while replaced approval stays auditable',()=>{
  const old={decision_id:'a',relationship_id:'old',left_ref:'woo:ww:1',right_ref:'square:square:2',status:'approved',reviewed_at:'2026-01-01'};
  const supersede={decision_id:'b',relationship_id:'old',left_ref:old.left_ref,right_ref:old.right_ref,status:'superseded',supersedes_decision_id:'a',reviewed_at:'2026-01-02'};
  const replacement={decision_id:'c',relationship_id:'new',left_ref:'woo:ww:1',right_ref:'shopify:shopify:3',status:'approved',replacement_for_decision_id:'a',reviewed_at:'2026-01-02'};
  const state=resolveMappingDecisions([old,supersede,replacement]);
  assert.deepEqual(state.activeApproved.map(x=>x.decision_id),['c']); assert.equal(state.history.length,3);
  assert.equal(buildCanonicalProductGraph([p(old.left_ref,'A'),p(old.right_ref,'B'),p(replacement.right_ref,'C')],approvedMappingEdges(state.history)).find(x=>x.source_products.includes(old.left_ref)).source_products.includes(replacement.right_ref),true);
});

test('bounded product search supports source filters, IDs and explicit mapping status without PII',()=>{
  const products=[p('woo:ww:45','Belcher Chain 45cm',{sku:'BC45',normalized_title:'belcher chain 45cm',line_items:9}),p('square:square:60','Belcher Chain 60cm',{sku:'BC60',line_items:50}),p('shopify:shopify:45','Chain',{sku:'BC45'})];
  const decisions=[{decision_id:'x',relationship_id:'x',...products[0],left_ref:products[0].source_product_ref,right_ref:products[2].source_product_ref,status:'approved'}];
  const results=searchProducts(products,{query:'45',sources:['woo'],limit:1,decisions});
  assert.equal(results.length,1);assert.equal(results[0].source,'woo:ww');assert.equal(results[0].explicit_mapping_status,'approved');assert.equal('customer' in results[0],false);
});

test('reviewer notes are normalized plain text and bounded',()=>{
  const note=sanitizeReviewerNote(`  Different\u0000 chain\n lengths ${'x'.repeat(600)} `);
  assert.equal(note.includes('\u0000'),false);assert.equal(note.includes('\n'),false);assert.equal(note.length,500);
});

test('historical Woo Ready To Ship products share a Shopify reporting family without becoming identity edges',()=>{
  const parent='shopify:shopify:micro-michael',history=[
    {decision_id:'f1',source_ref:'woo:ww:135969',shopify_parent_ref:parent,shopify_parent_title:'Micro Michael Rodent Pendant',status:'active',reviewed_at:'2026-09-23'},
    {decision_id:'f2',source_ref:'woo:ww:62682',shopify_parent_ref:parent,shopify_parent_title:'Micro Michael Rodent Pendant',status:'active',reviewed_at:'2026-09-23'}
  ];
  assert.equal(resolveFamilyDecisions(history).active.length,2);
  assert.equal(approvedMappingEdges(history).length,0);
  const lines=applyProductFamilies([{source_product_ref:'woo:ww:135969',units:1,sales:100},{source_product_ref:'woo:ww:62682',units:2,sales:200},{source_product_ref:parent,units:3,sales:300}],history);
  assert.equal(new Set(lines.map(x=>x.reporting_product_ref)).size,1);
  assert.equal(lines.reduce((n,x)=>n+x.units,0),6);assert.equal(lines.reduce((n,x)=>n+x.sales,0),600);assert.equal(lines.length,3);
});

test('family assignments reject a second Shopify parent and remain append-only through change and revoke',()=>{
  const active={decision_id:'a',source_ref:'woo:ww:135969',shopify_parent_ref:'shopify:shopify:micro',status:'active',reviewed_at:'2026-09-20'};
  assert.throws(()=>assertFamilyAssignment(active.source_ref,'shopify:shopify:other',[active]),/conflicting family assignment/);
  const changed=[active,{decision_id:'b',source_ref:active.source_ref,shopify_parent_ref:active.shopify_parent_ref,status:'superseded',supersedes_decision_id:'a',reviewed_at:'2026-09-21'},{decision_id:'c',source_ref:active.source_ref,shopify_parent_ref:'shopify:shopify:other',status:'active',replacement_for_decision_id:'a',reviewed_at:'2026-09-21'}];
  assert.deepEqual(resolveFamilyDecisions(changed).active.map(x=>x.decision_id),['c']);assert.equal(resolveFamilyDecisions(changed).history.length,3);
  const revoked=[...changed,{decision_id:'d',source_ref:active.source_ref,shopify_parent_ref:'shopify:shopify:other',status:'revoked',supersedes_decision_id:'c',reviewed_at:'2026-09-22'}];
  assert.equal(resolveFamilyDecisions(revoked).active.length,0);assert.equal(resolveFamilyDecisions(revoked).history.length,4);
});

test('ordinary exact identity remains separate from reporting-family resolution',()=>{
  const products=[p('woo:ww:1','Exact Pendant',{sku:'EX-1'}),p('shopify:shopify:2','Exact Pendant',{sku:'EX-1'})];
  assert.equal(mapProductPair([products[0]],[products[1]])[0].mapping_method,'exact_unique_sku');
  assert.equal(applyProductFamilies(products,[])[0].reporting_product_ref,'source:woo:ww:1');
});

test('choice preview explains the Micro Michael same-source identity conflict while allowing family assignment',()=>{
  const shopify='shopify:shopify:gid://shopify/Product/10434341601607';
  const products=[p('woo:ww:135969','Ready To Ship - Micro Michael Rodent Pendant'),p('woo:ww:62682','Micro Michael Rodent Pendant'),p(shopify,'Micro Michael Rodent Pendant')];
  const preview=buildProductChoicePreview({products,candidate:{candidate_id:'a'.repeat(24),left_ref:'woo:ww:135969',right_ref:shopify},selectedRef:shopify});
  assert.equal(preview.read_only,true);assert.equal(preview.identity_preview.allowed,false);assert.deepEqual(preview.identity_preview.conflicting_products.map(x=>x.source_product_ref).sort(),['woo:ww:135969','woo:ww:62682']);
  assert.equal(preview.family_preview.allowed,true);assert.equal(preview.family_preview.canonical_graph_changed,false);
  assert.deepEqual(preview.identity_component.map(x=>x.source_product_ref).sort(),[shopify,'woo:ww:62682'].sort());
});

test('choice preview allows a genuinely valid identity and separately exposes a conflicting family assignment',()=>{
  const shopify='shopify:shopify:gid://shopify/Product/10434341601607',source='woo:ww:135969';
  const products=[p(source,'Historical pendant'),p(shopify,'Current pendant'),p('shopify:shopify:other','Other parent')];
  const candidate={candidate_id:'b'.repeat(24),left_ref:source,right_ref:'square:square:old'};
  const valid=buildProductChoicePreview({products,candidate,selectedRef:shopify});assert.equal(valid.identity_preview.allowed,true);assert.equal(valid.family_preview.allowed,true);
  const conflict=buildProductChoicePreview({products,candidate,selectedRef:shopify,familyDecisions:[{decision_id:'f1',source_ref:source,shopify_parent_ref:'shopify:shopify:other',status:'active',reviewed_at:'2026-09-20'}]});
  assert.equal(conflict.family_preview.allowed,false);assert.match(conflict.family_preview.reason,/already assigned.*other/);
});

test('historical review labels Woo WW, Woo US and Square explicitly',()=>{
  assert.equal(productSourceLabel('woo:ww'),'WooCommerce WW');
  assert.equal(productSourceLabel('woo:usd'),'WooCommerce US');
  assert.equal(productSourceLabel('square:square'),'Square');
});

test('historical review queue leads with each source and keeps cross-source pairs as evidence',()=>{
  const products=[p('woo:ww:135969','Ready To Ship - Micro Michael Rodent Pendant'),p('square:square:michael','Michael Rodent')];
  const [candidate]=generateMappingCandidates(products,{minimumScore:.2});
  const queue=buildHistoricalReviewQueue(products,[candidate]);
  assert.deepEqual(queue.map(x=>x.historical_product.source_label).sort(),['Square','WooCommerce WW']);
  assert.equal(queue.find(x=>x.historical_product.source_product_id==='135969').evidence[0].right_source,'square:square');
  assert.ok(queue.every(x=>x.resolution_status==='needs_review'));
});

test('Shopify parent selection excludes variant identifiers',()=>{
  assert.equal(isShopifyParentProduct(p('shopify:shopify:gid://shopify/Product/10434341601607','Micro Michael')),true);
  assert.equal(isShopifyParentProduct(p('shopify:shopify:gid://shopify/ProductVariant/1','Micro Michael size 8')),false);
  assert.equal(isShopifyParentProduct(p('woo:ww:1','Historical')),false);
});

test('size-specific Woo variants suggest one Shopify parent family but never a Shopify variant',()=>{
  const source=p('woo:ww:8','Serpent Ring size 8',{sku:'SERP-8'}),parent=p('shopify:shopify:gid://shopify/Product/9','Serpent Ring',{sku:'SERP'}),variant=p('shopify:shopify:gid://shopify/ProductVariant/10','Serpent Ring size 8',{sku:'SERP-8'});
  const suggestions=suggestShopifyParents(source,[source,parent,variant]);
  assert.deepEqual(suggestions.map(x=>x.source_product_ref),[parent.source_product_ref]);
  assert.match(suggestions[0].conflicting_evidence.join(' '),/SKU differs|variant\/size/);
});

test('ambiguous Shopify suggestions stay visibly ambiguous and never become confirmations',()=>{
  const source=p('square:square:1','Silver Skull Ring'),products=[source,p('shopify:shopify:2','Silver Skull Ring'),p('shopify:shopify:3','Silver Skull Ring')];
  const suggestions=suggestShopifyParents(source,products);
  assert.equal(suggestions.length,2);assert.ok(suggestions.every(x=>x.ambiguous));
  const [row]=buildHistoricalReviewQueue(products,[]);assert.equal(row.resolution_status,'needs_review');assert.equal(row.active_identity_mapping,null);
});

test('coverage reports unresolved historical impact, resolutions, outcomes and classification impact by source',()=>{
  const products=[p('woo:ww:1','Exact Ring',{line_items:3,sales:30}),p('woo:usd:2','Old Ring',{line_items:5,sales:50}),p('square:square:3','Shipping',{line_items:7,sales:70}),p('shopify:shopify:4','Exact Ring')];
  const mappings=[{decision_id:'m',left_ref:'woo:ww:1',right_ref:'shopify:shopify:4',status:'approved'}],outcomes=[{source_ref:'woo:usd:2',outcome:'no_equivalent',reviewed_at:'2026-01-01'}];
  const queue=buildHistoricalReviewQueue(products,[],{mappingDecisions:mappings,reviewOutcomes:outcomes}),coverage=buildProductMappingCoverage(products,queue,{mappingDecisions:mappings,reviewOutcomes:outcomes});
  assert.equal(coverage.by_source['woo:usd'].order_lines,5);assert.equal(coverage.by_source['woo:usd'].no_equivalent,1);assert.equal(coverage.by_source['square:square'].intentional_exclusions.shipping.order_lines,7);assert.equal(coverage.completed,2);assert.equal(coverage.remaining,0);assert.equal(coverage.reconciliation.reconciled,true);
});

test('production-shaped coverage assigns every historical product to one non-overlapping state',()=>{
  const completed=Array.from({length:42},(_,i)=>p(`woo:ww:c${i}`,'Completed ring'));
  const reviewable=Array.from({length:2412},(_,i)=>p(`woo:usd:r${i}`,'Review ring'));
  const excluded=Array.from({length:1138},(_,i)=>p(`square:square:x${i}`,'Shipping'));
  const mappings=completed.map((row,i)=>({decision_id:`m${i}`,left_ref:row.source_product_ref,right_ref:`shopify:shopify:${i}`,status:'approved'}));
  const products=[...completed,...reviewable,...excluded];
  const coverage=buildProductMappingCoverage(products,buildHistoricalReviewQueue(products,[],{mappingDecisions:mappings}),{mappingDecisions:mappings});
  assert.equal(coverage.total,3592);assert.equal(coverage.completed,42);assert.equal(coverage.remaining,2412);assert.equal(coverage.categories.intentional_exclusions,1138);
  assert.equal(Object.values(coverage.by_source).reduce((n,value)=>n+value.products,0),3592);assert.deepEqual(coverage.reconciliation,{equation:'total = completed + remaining + deterministic_match + intentional_exclusions',reconciled:true,overlap_products:0,missing_products:0});
});

test('money contracts preserve currencies and never add Square minor units to Woo major units',()=>{
  const products=[p('woo:ww:1','Ring',{currency:'GBP',monetary_unit:'major_unit',sales:10}),p('woo:usd:2','Ring',{currency:'USD',monetary_unit:'major_unit',sales:20}),p('square:square:3','Ring',{currency:'GBP',monetary_unit:'minor_unit',sales:300})];
  const coverage=buildProductMappingCoverage(products,buildHistoricalReviewQueue(products,[]));
  assert.deepEqual(productMoneyContract('square:square'),{currency_field:'currency',amount_field:'total_amount',monetary_unit:'minor_unit'});
  assert.deepEqual(coverage.by_source['square:square'].sales_by_currency,[{currency:'GBP',monetary_unit:'minor_unit',sales:300}]);
  assert.deepEqual(coverage.by_source['woo:ww'].sales_by_currency,[{currency:'GBP',monetary_unit:'major_unit',sales:10}]);
});

test('queue resolution state distinguishes active identity and active reporting family',()=>{
  const products=[p('woo:usd:1','US Skull'),p('square:square:2','Square Skull'),p('shopify:shopify:3','Shopify Skull')];
  const evidence=[{candidate_id:'a'.repeat(24),left_ref:products[0].source_product_ref,right_ref:products[1].source_product_ref,left_title:products[0].title,right_title:products[1].title,left_source:'woo:usd',right_source:'square:square',score:.8}];
  const queue=buildHistoricalReviewQueue(products,evidence,{mappingDecisions:[{decision_id:'i',left_ref:products[0].source_product_ref,right_ref:products[2].source_product_ref,status:'approved'}],familyDecisions:[{decision_id:'f',source_ref:products[1].source_product_ref,shopify_parent_ref:products[2].source_product_ref,status:'active'}]});
  assert.equal(queue.find(x=>x.historical_product.source_product_ref===products[0].source_product_ref).resolution_status,'active_identity');
  assert.equal(queue.find(x=>x.historical_product.source_product_ref===products[1].source_product_ref).resolution_status,'active_reporting_family');
});

test('review list tolerates unstable source rows and preserves empty and non-empty search',async()=>{
  const products=[p('woo:ww:1','Moon Skull Ring'),p('shopify:shopify:2','Moon Skull Ring'),{source_product_ref:null,source_platform:'shopify',source_store:'shopify',source_product_id:null,title:'Custom item'}];
  const table={exists:async()=>[true],getMetadata:async()=>[{schema:{fields:[]}}],setMetadata:async()=>{}};
  const bigquery={dataset:()=>({exists:async()=>[true],table:()=>table}),query:async()=>[[]]};
  const service=createProductMappingService({bigquery,project:'demo'});
  const empty=await service.list({products,search:''}),found=await service.list({products,search:'moon'}),missing=await service.list({products,search:'not present'});
  assert.equal(empty.items.length,1);assert.equal(found.items.length,1);assert.equal(missing.items.length,0);
  assert.doesNotThrow(()=>JSON.stringify(empty));
});
