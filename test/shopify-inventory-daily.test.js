import test from 'node:test';
import assert from 'node:assert/strict';
import {collect,londonDate,publicationSql,assertRetained,safeError} from '../shopify/inventory-daily.js';
const page=(nodes,next)=>({nodes,pageInfo:{hasNextPage:!!next,endCursor:next??null}});
const now=()=>new Date('2026-11-10T02:20:00Z');
function fixture(fault){
  return async(q,{id,after,ids,location})=>{
    if(q.includes('query Locations'))return {locations:after?page([{id:'b',name:'Soho Workshop',isActive:true}]):page([{id:'a',name:'Soho',isActive:true}],'locations')};
    if(q.includes('query Products'))return {products:after?page([{id:'p2',title:'B',status:'ARCHIVED'}]):page([{id:'p1',title:'A',status:'ACTIVE'}],'products')};
    if(q.includes('query Variants'))return {product:{variants:page([{id:fault==='duplicate'?'v':id+String(after),title:'Default',inventoryItem:{id:id+String(after),tracked:id==='p1'&&!after}}],id==='p1'&&!after?'variants':null)}};
    if(fault==='partial')return {nodes:[null]};
    return {nodes:ids.map(id=>({id,tracked:true,inventoryLevel:location==='a'?{location:{id:location},quantities:[{name:'available',quantity:0},{name:'on_hand',quantity:-2}]}:null}))};
  };
}
test('paginates all levels and preserves explicit stock and missing states',async()=>{
  const r=await collect(fixture(),{now});
  assert.equal(r.rows.length,6);
  assert.deepEqual([r.rows[0],r.rows[3]].map(x=>[x.available,x.on_hand,x.stock_state,x.workshop]),
    [[0,-2,'missing_quantity',false],[null,null,'unstocked',true]]);
  assert.equal(r.rows[1].stock_state,'untracked');
  assert.equal(r.rows[2].product_status,'ARCHIVED');
});
test('fails closed on duplicate variant, failed pagination, and bounds',async()=>{
  await assert.rejects(collect(fixture('duplicate'),{now}),/INVALID_VARIANT/);
  await assert.rejects(collect(fixture('partial'),{now}),/INVALID_BATCH/);
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

test('catalogue-scale batching covers 12000 variants and six locations in 1562 calls',async()=>{
  const progress=[];let calls=0;
  const graphql=async(q,{after,ids,location})=>{
    calls++;
    if(q.includes('query Locations'))return {locations:page(Array.from({length:6},(_,i)=>({id:'l'+i,name:i?'Shop':'Workshop',isActive:true})))};
    if(q.includes('query Products'))return {products:page([{id:'p',title:'Sold out',status:'ARCHIVED'}])};
    if(q.includes('query Variants')){
      const start=Number(after||0),end=Math.min(start+100,12000);
      return {product:{variants:page(Array.from({length:end-start},(_,j)=>({id:'v'+(start+j),inventoryItem:{id:'i'+(start+j),tracked:true}})),end<12000?String(end):null)}};
    }
    assert.ok(ids.length<=50);
    return {nodes:ids.map(id=>({id,tracked:true,inventoryLevel:{location:{id:location},quantities:[{name:'available',quantity:-1},{name:'on_hand',quantity:0},{name:'committed',quantity:1},{name:'incoming',quantity:0}]}}))};
  };
  const r=await collect(graphql,{now,onProgress:x=>progress.push(x)});
  assert.equal(r.rows.length,72000);
  assert.equal(calls,1562);
  assert.ok(calls<1600); // Old path needed at least 12000 inventory reads alone.
  assert.ok(r.rows.every(x=>x.available===-1));
  assert.equal(progress.at(-1).status,'complete');
});
test('throttle retries and failed or interrupted batches never yield a publishable snapshot',async()=>{
  const f=fixture(),progress=[];let n=0;
  const r=await collect(async(q,v,s)=>{if(q.includes('InventoryBatch')&&!n++)throw Object.assign(Error('secret'),{code:'THROTTLED'});return f(q,v,s);},
    {now,sleep:async()=>{},onProgress:x=>progress.push(x)});
  assert.equal(r.rows.length,6);assert.ok(progress.some(x=>x.status==='throttled'));
  const signal=AbortSignal.abort();
  await assert.rejects(collect(fixture(),{now,signal}));
  assert.deepEqual(safeError({message:'private payload',code:'BAD_PRIVATE_CODE',http_status:403}),
    {error_code:'UNCLASSIFIED',http_status:403});
});
