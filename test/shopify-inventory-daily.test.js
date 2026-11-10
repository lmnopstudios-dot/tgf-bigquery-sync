import test from 'node:test';
import assert from 'node:assert/strict';
import {collect,londonDate,publicationSql,assertRetained} from '../shopify/inventory-daily.js';
const page=(nodes,next)=>({nodes,pageInfo:{hasNextPage:!!next,endCursor:next??null}});
const now=()=>new Date('2026-11-10T02:20:00Z');
function fixture(fault){
  return async(q,{id,after})=>{
    if(q.includes('query Locations'))return {locations:after?page([{id:'b',name:'Soho Workshop',isActive:true}]):page([{id:'a',name:'Soho',isActive:true}],'locations')};
    if(q.includes('query Products'))return {products:after?page([{id:'p2',title:'B',status:'ARCHIVED'}]):page([{id:'p1',title:'A',status:'ACTIVE'}],'products')};
    if(q.includes('query Variants'))return {product:{variants:page([{id:fault==='duplicate'?'v':id+String(after),title:'Default',inventoryItem:{id,tracked:id==='p1'&&!after}}],id==='p1'&&!after?'variants':null)}};
    if(fault==='partial'&&after)return {inventoryItem:null};
    return {inventoryItem:{inventoryLevels:after?page([{location:{id:'inactive'},quantities:[]}]):page([{location:{id:'a'},quantities:[{name:'available',quantity:0},{name:'on_hand',quantity:-2}]}],'levels')}};
  };
}
test('paginates all levels and preserves explicit stock and missing states',async()=>{
  const r=await collect(fixture(),{now});
  assert.equal(r.rows.length,6);
  assert.deepEqual(r.rows.slice(0,2).map(x=>[x.available,x.on_hand,x.stock_state,x.workshop]),
    [[0,-2,'missing_quantity',false],[null,null,'unstocked',true]]);
  assert.equal(r.rows[2].stock_state,'untracked');
  assert.equal(r.rows[4].product_status,'ARCHIVED');
});
test('fails closed on duplicate variant, failed pagination, and bounds',async()=>{
  await assert.rejects(collect(fixture('duplicate'),{now}),/INVALID_VARIANT/);
  await assert.rejects(collect(fixture('partial'),{now}),/INVALID_PAGE/);
  await assert.rejects(collect(fixture(),{now,maxCalls:2}),/CALL_LIMIT/);
});
test('London day boundaries and day crossover',async()=>{
  assert.equal(londonDate(new Date('2026-07-01T23:00:00Z')),'2026-07-02');
  assert.equal(londonDate(new Date('2026-11-01T23:00:00Z')),'2026-11-01');
  let n=0;
  await assert.rejects(collect(fixture(),{now:()=>new Date(n++?'2026-07-02T00:00:00Z':'2026-07-01T22:59:00Z')}),/LONDON_DATE_CHANGED/);
});
test('retention guard rejects table and partition expiry',()=>{
  assert.doesNotThrow(()=>assertRetained({type:'TABLE',timePartitioning:{type:'DAY'}}));
  for(const m of [{type:'VIEW'},{type:'TABLE',expirationTime:'123'},{type:'TABLE',timePartitioning:{expirationMs:'123'}}])
    assert.throws(()=>assertRetained(m),/UNSAFE/);
});
test('publication locks before retry check and validates before atomic promotion',()=>{
  const sql=publicationSql('live','manifest','stage');
  assert.match(sql,/BEGIN TRANSACTION;\s+UPDATE manifest[\s\S]+IF NOT EXISTS[\s\S]+COUNT\(DISTINCT[\s\S]+INSERT INTO live[\s\S]+INSERT INTO manifest[\s\S]+COMMIT TRANSACTION/);
});
