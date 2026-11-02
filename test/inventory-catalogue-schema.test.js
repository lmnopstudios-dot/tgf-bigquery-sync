import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {validateInventoryProduct,readInventoryReport,inventoryReportWorkbook} from '../oracle/inventory-report.js';
const gid=(type,id)=>`gid://shopify/${type}/${id}`;
const product=(id,status='ACTIVE',tags=[])=>({id:gid('Product',id),title:`P${id}`,status,tags});
const page=(nodes,next=null)=>({nodes,pageInfo:{hasNextPage:Boolean(next),endCursor:next}});
function schemaFixture({invalid=null,failLocation=false}={}){
 const calls=[];const graphql=async(t,q,a)=>{calls.push({q,a});assert.doesNotMatch(q,/mutation/);
  if(q.includes('InventoryCatalogue'))return{products:!a.cursor?page([product(1),invalid||product(2,'UNLISTED'),product(3,'DRAFT'),product(4,'ARCHIVED'),product(5,'ACTIVE',['made-to-order'])],'next'):page([product(6)])};
  if(q.includes('InventoryReportLocations'))return{locations:page(Array.from({length:6},(_,i)=>({id:gid('Location',i+1),name:`Location ${i+1}`,isActive:true})))};
  if(q.includes('InventoryReportVariants')){const id=a.id.split('/').at(-1);return{product:{variants:page([{id:gid('ProductVariant',id),title:'Size',sku:`S${id}`,selectedOptions:[{name:'Size',value:'L'}],inventoryItem:{id:gid('InventoryItem',id),tracked:id!=='3'}}])}};}
  if(q.includes('InventoryReportLevels')){if(failLocation&&a.location===gid('Location',6))throw Object.assign(new Error('private'),{code:'ACCESS_DENIED'});return{nodes:a.ids.map(id=>({id,inventoryLevel:a.location===gid('Location',3)?null:{quantities:[{name:'available',quantity:a.location===gid('Location',1)?0:a.location===gid('Location',2)?-3:5},{name:'on_hand',quantity:7},{name:'committed',quantity:2}]}}))};}
  assert.fail(q);
 };return{graphql,getToken:async()=> 'fixture',calls};
}
test('current Shopify UNLISTED status is valid; full pagination retains subsequent products and all six locations',async()=>{
 assert.equal(validateInventoryProduct(product(2,'UNLISTED')).status,'UNLISTED');
 const f=schemaFixture(),e=await readInventoryReport(f);assert.equal(e.complete,true);assert.equal(e.population.catalogue_complete,true);assert.deepEqual(e.products.map(p=>p.id),[1,2,3,6].map(id=>gid('Product',id)));assert.equal(e.population.status_counts.UNLISTED,1);assert.equal(e.locations.length,6);assert.equal(e.products[1].status,'UNLISTED');assert.equal(f.calls.filter(c=>c.q.includes('InventoryCatalogue')).length,2);
 for(const p of e.products)assert.equal(p.variants[0].locations.length,6);
 assert.equal(e.products[0].variants[0].locations[0].available,0);assert.equal(e.products[0].variants[0].locations[1].available,-3);assert.equal(e.products[0].variants[0].locations[2].evidence_state,'unstocked');assert.equal(e.products[2].variants[0].locations[0].evidence_state,'untracked');
 const wb=new ExcelJS.Workbook();await wb.xlsx.load(await inventoryReportWorkbook(e));assert.equal(wb.getWorksheet('Inventory').rowCount,5);assert.equal(wb.getWorksheet('Location quantities').rowCount,25);assert.equal(wb.getWorksheet('Product eligibility').rowCount,7);
});
test('explicit active-and-draft population validates UNLISTED then records its deliberate exclusion',async()=>{
 const e=await readInventoryReport({...schemaFixture(),entityQuery:'active and draft products without made-to-order tag'});assert.equal(e.complete,true);assert.deepEqual(e.products.map(p=>p.status),['ACTIVE','DRAFT','ACTIVE']);assert.deepEqual(e.population.audit.find(p=>p.status==='UNLISTED'),{product_id:gid('Product',2),status:'UNLISTED',eligible:false,exclusion:'outside_requested_statuses'});assert.equal(e.locations.length,6);
});
for(const [bad,field,type,value] of [[product(2,'FUTURE_STATUS'),'status','string','FUTURE_STATUS'],[{...product(2),tags:null},'tags','null',null],[{...product(2),tags:['ok',17]},'tags[1]','number',17],[{...product(2),id:''},'id','string',null]])test(`field-level rejection of ${field} preserves partial coverage without skipping it`,async()=>{
 const e=await readInventoryReport(schemaFixture({invalid:bad}));assert.equal(e.complete,false);const failure=e.failures.find(f=>f.code==='INVENTORY_INVALID_PRODUCT');assert.deepEqual({field:failure.validation.field,type:failure.validation.observed_type,value:failure.validation.observed_value,page:failure.validation.page,index:failure.validation.index},{field,type,value,page:1,index:1});assert.equal(e.products.length,1);assert.equal(e.locations.length,6);assert.equal(e.population.catalogue_complete,false);
});
test('malformed values cannot inject private provider data into diagnostics',()=>{
 try{validateInventoryProduct({...product(1),status:'private-token=not-an-enum',title:'private title',tags:['private tag']});assert.fail();}catch(error){assert.equal(error.catalogue_validation.field,'status');assert.equal(error.catalogue_validation.observed_value,null);assert.doesNotMatch(JSON.stringify(error),/private/);}
});
test('a location read failure preserves all six columns and genuine numeric zero versus failed reads',async()=>{
 const e=await readInventoryReport(schemaFixture({failLocation:true}));assert.equal(e.complete,false);assert.equal(e.locations.length,6);assert.equal(e.products[0].variants[0].locations[5].evidence_state,'failed');assert.equal(e.products[0].variants[0].locations[5].available,null);assert.equal(e.products[0].variants[0].locations[0].available,0);
});
test('retained Render boundary: UNLISTED at page 1 index 38 no longer stops the catalogue',async()=>{
 const {readFile}=await import('node:fs/promises'),retained=JSON.parse(await readFile(new URL('./fixtures/inventory-5a29d1f7/catalogue-validation.json',import.meta.url),'utf8'));
 const f=schemaFixture(),graphql=async(t,q,a,s)=>q.includes('InventoryCatalogue')?{products:!a.cursor?page([...Array.from({length:38},(_,i)=>product(100+i)),{id:retained.product_id,title:'Synthetic title',tags:[],status:retained.observed_value}],'next'):page([product(999)])}:f.graphql(t,q,a,s);
 const e=await readInventoryReport({...f,graphql});assert.equal(e.complete,true);assert.equal(e.products.length,40);assert.equal(e.products[38].id,retained.product_id);assert.equal(e.products[38].status,'UNLISTED');assert.equal(e.products[39].id,gid('Product',999));assert.equal(e.locations.length,6);assert.equal(e.failures.length,0);
});
