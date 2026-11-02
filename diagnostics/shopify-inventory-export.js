// Read-only Shopify validation. Uses deployed credentials through the normal
// client; persists only a local workbook, never changes tags/products/stock.
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {loadShopifyConfig,getShopifyAccessToken,createShopifyGraphql} from '../shopify/admin-client.js';
import {createCurrentStockService} from '../oracle/current-stock.js';
import {createMemoryExportStore} from '../oracle/product-priority-storage.js';
import {executeGovernedAgentAnalysis} from '../oracle/analysis-route-dispatcher.js';
import {assertInventoryArtifact} from '../oracle/inventory-report.js';

const message='Show inventory at every active Shopify location for all products that do not have the `made-to-order` tag.';
try{
  const output=resolve(process.argv.find(arg=>arg.startsWith('--output='))?.slice(9)||'/tmp/oracle-inventory.xlsx');
  if(!output.endsWith('.xlsx'))throw Object.assign(new Error(),{code:'XLSX_OUTPUT_REQUIRED'});
  const config=loadShopifyConfig(),store=createMemoryExportStore();
  const service=createCurrentStockService({artifactStore:store,getToken:signal=>getShopifyAccessToken(config,fetch,signal),graphql:(token,query,args,signal)=>createShopifyGraphql({shop:config.shop,token})(query,args,signal)});
  const result=await executeGovernedAgentAnalysis({message,baselineOverview:service,baselineOptions:{exportOwner:'read-only-render-validation',requestId:crypto.randomUUID(),deadlineAt:Date.now()+600000}});
  const artifact=await store.get(result.artifact.id,'read-only-render-validation');await assertInventoryArtifact(artifact);
  await writeFile(output,Buffer.from(artifact.xlsx_base64,'base64'));
  const e=artifact.envelope,states={};for(const p of e.products)for(const v of p.variants)for(const l of v.locations)states[l.evidence_state]=(states[l.evidence_state]||0)+1;
  const tags=e.tag_convention.observed_tags.filter(t=>/made|order/i.test(t.tag)),canonical=tags.filter(t=>t.tag.trim().toLowerCase()==='made-to-order');
  const passed=e.complete&&e.tag_convention.catalogue_complete&&canonical.length>0;
  console.log(JSON.stringify({validation:'shopify_inventory_export',read_only:true,status:passed?'passed':'incomplete',live_validation:passed?'verified':'pending',tag_convention:e.tag_convention.predicate,observed_related_tags:tags,excluded_tag_observed:canonical.length>0,products:e.products.length,product_statuses:[...new Set(e.products.map(p=>p.status))],variants:e.products.reduce((n,p)=>n+p.variants.length,0),active_locations:e.locations,quantity_states:states,coverage_complete:e.complete,failures:e.failures,started_at:e.started_at,finished_at:e.as_of,limits:e.limits,workbook:output,workbook_sha256:artifact.sha256,workbook_integrity:'verified'},null,2));
  if(!passed)process.exitCode=1;
}catch(error){console.error(JSON.stringify({validation:'shopify_inventory_export',read_only:true,status:'failed',live_validation:'pending',code:/^[A-Z][A-Z0-9_]{0,63}$/.test(error.code||'')?error.code:'VALIDATION_FAILED',http_status:typeof error.http_status==='number'?error.http_status:null}));process.exitCode=1;}
