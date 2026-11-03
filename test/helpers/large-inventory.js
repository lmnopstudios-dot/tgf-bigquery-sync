import {realInventoryLocations} from './filtered-inventory.js';
const gid=(type,id)=>`gid://shopify/${type}/${id}`;
const page=(nodes,next=null)=>({nodes,pageInfo:{hasNextPage:next!==null,endCursor:next===null?null:String(next)}});
// 553 eligible parents, 9,322 variants, 6 catalogue pages, one location page,
// 553 variant pages and 748 level batches = 1,308 read requests. Remote double.
export function largeInventoryFixture({partial=false,allQualify=false}={}){
 const calls=[];const products=Array.from({length:553},(_,i)=>({id:gid('Product',i+1),title:`Handcrafted sterling silver collection ${i+1} adjustable ring`,status:'ACTIVE',tags:i%7===0?['made-to-order','silver','rings']:['silver','rings']}));
 const variants=new Map();let next=0;
 for(const [i,p] of products.entries())variants.set(p.id,Array.from({length:16+(i<474?1:0)},()=>{const n=++next;return{id:gid('ProductVariant',n),title:`Size ${n%20+1}`,sku:`RING-SILVER-${String(n).padStart(6,'0')}`,selectedOptions:[{name:'Size',value:String(n%20+1)},{name:'Metal',value:'Sterling Silver'}],inventoryItem:{id:gid('InventoryItem',n),tracked:n!==9322}};}));
 return{calls,getToken:async()=> 'fixture',graphql:async(_,query,args)=>{
  calls.push({query,args});
  if(query.includes('InventoryCatalogue')){const offset=Number(args.cursor||0);return{products:page(products.slice(offset,offset+100),offset+100<products.length?offset+100:null)};}
  if(query.includes('InventoryReportLocations'))return{locations:page(realInventoryLocations)};
  if(query.includes('InventoryReportVariants'))return{product:{variants:page(variants.get(args.id))}};
  if(query.includes('InventoryReportLevels'))return{nodes:args.ids.filter(id=>!(partial&&id===gid('InventoryItem',9320)&&args.location===realInventoryLocations[3].id)).map(id=>{
   const n=Number(id.split('/').at(-1)),l=realInventoryLocations.findIndex(loc=>loc.id===args.location),qualified=allQualify||n%71===0;
   const available=qualified?[5,3,2,(n%3)-1][l]:[1,2,0,5][l];
   return{id,inventoryLevel:n===9321&&l===3?null:{quantities:[{name:'available',quantity:available},{name:'on_hand',quantity:available+2},{name:'committed',quantity:2}]}};
  })};
  throw new Error('Unexpected query');
 }};
}
