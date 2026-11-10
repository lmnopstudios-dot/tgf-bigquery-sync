import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {setTimeout as pause} from 'node:timers/promises';
import {loadShopifyConfig,getShopifyAccessToken,createShopifyGraphql} from './admin-client.js';
import {createBigQueryClient} from '../bigquery/client.js';
import {datasetLocation,assertDatasetIdentifier} from '../bigquery/dataset-location.js';

const TZ='Europe/London';
export const londonDate=date=>new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
const fields=['available','on_hand','committed','incoming'];
const q=(name,body)=>`query ${name}($after:String){${body}}`;
const products=q('Products','products(first:100,after:$after){nodes{id title status} pageInfo{hasNextPage endCursor}}');
const locations=q('Locations','locations(first:100,after:$after,includeInactive:true,includeLegacy:true){nodes{id name isActive} pageInfo{hasNextPage endCursor}}');
const variants='query Variants($id:ID!,$after:String){product(id:$id){variants(first:100,after:$after){nodes{id title sku inventoryItem{id tracked}} pageInfo{hasNextPage endCursor}}}}';
const levels='query Levels($id:ID!,$after:String){inventoryItem(id:$id){inventoryLevels(first:100,after:$after){nodes{location{id} quantities(names:["available","on_hand","committed","incoming"]){name quantity}} pageInfo{hasNextPage endCursor}}}}';
const check=(ok,code)=>{if(!ok)throw Error(code);};
export async function collect(graphql,{now=()=>new Date(),signal=AbortSignal.timeout(900000),maxCalls=14000,maxRows=250000}={}){
  const start=now(),date=londonDate(start),rows=[];
  let calls=0;
  async function* pages(query,vars,select){
    let after=null;const seen=new Set();
    do{
      let data;
      for(let attempt=0;;attempt++){
        signal.throwIfAborted();
        check(++calls<=maxCalls,'CALL_LIMIT');
        try{data=await graphql(query,{...vars,after},signal);break;}
        catch(e){if(attempt>=3||e.code!=='THROTTLED')throw e;await pause(1000*2**attempt,undefined,{signal});}
      }
      const page=select(data),observed=now().toISOString();
      check(Array.isArray(page?.nodes)&&typeof page.pageInfo?.hasNextPage==='boolean','INVALID_PAGE');
      for(const node of page.nodes){check(node,'INVALID_NODE');yield [node,observed];}
      if(!page.pageInfo.hasNextPage)return;
      after=page.pageInfo.endCursor;
      check(typeof after==='string'&&after&&!seen.has(after)&&page.nodes.length,'INVALID_CURSOR');
      seen.add(after);
    }while(true);
  }
  const stores=new Map(),ps=new Set(),vs=new Set();
  for await(const [l] of pages(locations,{},d=>d?.locations)){
    check(l.id&&!stores.has(l.id)&&typeof l.isActive==='boolean','INVALID_LOCATION');stores.set(l.id,l);
  }
  const active=[...stores.values()].filter(l=>l.isActive);
  check(active.length,'NO_ACTIVE_LOCATIONS');
  for await(const [p] of pages(products,{},d=>d?.products)){
    check(p.id&&!ps.has(p.id),'DUPLICATE_PRODUCT');ps.add(p.id);
    for await(const [v,variantSeen] of pages(variants,{id:p.id},d=>d?.product?.variants)){
      check(v.id&&!vs.has(v.id)&&v.inventoryItem?.id&&typeof v.inventoryItem.tracked==='boolean','INVALID_VARIANT');vs.add(v.id);
      const item=v.inventoryItem, byLocation=new Map();
      let last=variantSeen;
      if(item.tracked)for await(const [l,observed] of pages(levels,{id:item.id},d=>d?.inventoryItem?.inventoryLevels)){
        const id=l.location?.id;
        check(id&&!byLocation.has(id)&&Array.isArray(l.quantities),'INVALID_LEVEL');
        const quantities=new Map();
        for(const r of l.quantities){
          check(r&&fields.includes(r.name)&&!quantities.has(r.name)&&Number.isSafeInteger(r.quantity),'INVALID_QUANTITY');
          quantities.set(r.name,r.quantity);
        }
        byLocation.set(id,{quantities,observed});last=observed;
      }
      if(item.tracked)last=now().toISOString();
      for(const l of active){
        check(rows.length<maxRows,'ROW_LIMIT');
        const level=byLocation.get(l.id);
        rows.push({snapshot_date:date,product_id:p.id,product_name:p.title,product_status:p.status,
          variant_id:v.id,variant_name:v.title,sku:v.sku,inventory_item_id:item.id,location_id:l.id,
          location_name:l.name,workshop:/\bworkshop\b/i.test(l.name),observed_at:level?.observed??last,
          stock_state:!item.tracked?'untracked':!level?'unstocked':fields.every(n=>level.quantities.has(n))?'observed':'missing_quantity',
          ...Object.fromEntries(fields.map(n=>[n,level?.quantities.get(n)??null]))});
      }
    }
  }
  const end=now();
  check(rows.length&&rows.length===vs.size*active.length,'INCOMPLETE_MATRIX');
  check(londonDate(end)===date,'LONDON_DATE_CHANGED');
  return {date,rows,calls,variants:vs.size,locations:active.length,start:start.toISOString(),end:end.toISOString()};
}

const schema='snapshot_date DATE, product_id STRING, product_name STRING, product_status STRING, variant_id STRING, variant_name STRING, sku STRING, inventory_item_id STRING, location_id STRING, location_name STRING, workshop BOOL, observed_at TIMESTAMP, stock_state STRING, available INT64, on_hand INT64, committed INT64, incoming INT64';
export function assertRetained(meta){
  check(meta?.type==='TABLE'&&meta.expirationTime==null&&meta.timePartitioning?.expirationMs==null,'UNSAFE_EXPIRATION_OR_TYPE');
}
export function publicationSql(live,manifest,stage){
  return `BEGIN TRANSACTION;
    UPDATE ${manifest} SET row_count=0 WHERE snapshot_date IS NULL;
    ASSERT @@row_count=1 AS 'Missing publication lock';
    IF NOT EXISTS(SELECT 1 FROM ${manifest} WHERE snapshot_date=DATE(@date)) THEN
      ASSERT (SELECT COUNT(*)=@expected AND COUNT(DISTINCT TO_JSON_STRING(STRUCT(variant_id,location_id)))=@expected
        AND COUNTIF(snapshot_date IS NULL OR snapshot_date!=DATE(@date) OR variant_id IS NULL OR location_id IS NULL)=0 FROM ${stage})
        AS 'Incomplete or duplicate staged rows';
      INSERT INTO ${live} SELECT * FROM ${stage};
      INSERT INTO ${manifest} VALUES (DATE(@date),@expected,@variants,@locations,TIMESTAMP(@start),TIMESTAMP(@end));
    END IF;
    COMMIT TRANSACTION;`;
}
async function main(){
  const mode=process.argv[2];
  check(['preview','setup','apply','check'].includes(mode)&&process.argv.length===3,'INVALID_MODE');
  if(['setup','apply'].includes(mode))check(process.env.SHOPIFY_INVENTORY_DAILY_ENABLED==='true','WRITES_DISABLED');
  async function read(){
    const config=loadShopifyConfig(), signal=AbortSignal.timeout(900000);
    const token=await getShopifyAccessToken(config,fetch,signal);
    return collect(createShopifyGraphql({shop:config.shop,token}),{signal});
  }
  const summary=({rows,...x})=>({...x,row_count:rows.length});
  if(mode==='preview'){console.log(JSON.stringify({status:'preview',...summary(await read())}));return;}
  const {bigquery,project}=createBigQueryClient();assertDatasetIdentifier(project);
  const dataset='shopify_data', location=await datasetLocation(bigquery,project,dataset);
  const t=n=>'`'+project+'.'+dataset+'.'+n+'`';
  const ln='inventory_daily_snapshots',mn='inventory_daily_manifest';
  const live=t(ln),manifest=t(mn);
  const run=(query,params={})=>bigquery.query({query,params,location,useLegacySql:false,maximumBytesBilled:'1000000000',jobTimeoutMs:60000});
  const retained=async()=>{for(const n of [ln,mn])assertRetained((await bigquery.dataset(dataset).table(n).getMetadata())[0]);};
  if(mode==='setup'){
    const [metadata]=await bigquery.dataset(dataset).getMetadata();
    check(!Number(metadata.defaultTableExpirationMs)&&!Number(metadata.defaultPartitionExpirationMs),'UNSAFE_DATASET_DEFAULTS');
    await run(`CREATE TABLE IF NOT EXISTS ${live} (${schema}) PARTITION BY snapshot_date CLUSTER BY variant_id,location_id;`);
    await run(`CREATE TABLE IF NOT EXISTS ${manifest} (snapshot_date DATE,row_count INT64,variants INT64,locations INT64,started_at TIMESTAMP,ended_at TIMESTAMP)
      AS SELECT CAST(NULL AS DATE),0,0,0,CAST(NULL AS TIMESTAMP),CAST(NULL AS TIMESTAMP);`);
    await retained();console.log('inventory_daily_setup_verified');return;
  }
  await retained();
  if(mode==='check'){
    const [r]=await run(`SELECT m.snapshot_date,m.row_count,m.variants,m.locations,m.started_at,m.ended_at,
      m.ended_at<=TIMESTAMP(DATETIME(m.snapshot_date,TIME '04:00:00'),'UTC') on_time,
      (SELECT COUNT(*) FROM ${live} WHERE snapshot_date=CURRENT_DATE('Europe/London')) actual_rows
      FROM ${manifest} m WHERE m.snapshot_date=CURRENT_DATE('Europe/London')`);
    check(r.length===1&&Number(r[0].row_count)>0&&Number(r[0].row_count)===Number(r[0].actual_rows),'MISSING_OR_INCOMPLETE_SNAPSHOT');
    console.log(JSON.stringify(r[0]));check(r[0].on_time===true,'LATE_SNAPSHOT');return;
  }
  const snapshot=await read(),{date,rows,variants,locations,start,end}=snapshot;
  const stage=t('_inventory_daily_'+randomUUID().replaceAll('-',''));
  await run(`CREATE TABLE ${stage} (${schema}) OPTIONS(expiration_timestamp=TIMESTAMP_ADD(CURRENT_TIMESTAMP(),INTERVAL 2 HOUR))`);
  // Bounded parameter batches, no streaming buffer or partially visible live writes.
  const columns=schema.split(', ').map(x=>x.split(' '));
  for(let i=0;i<rows.length;i+=500){
    const select=columns.map(([n,type])=>`CAST(JSON_VALUE(r,'$.${n}') AS ${type})`).join(',');
    await run(`INSERT INTO ${stage} SELECT ${select} FROM UNNEST(JSON_QUERY_ARRAY(PARSE_JSON(@payload))) r`,
      {payload:JSON.stringify(rows.slice(i,i+500))});
  }
  await retained();
  await run(publicationSql(live,manifest,stage),{date,expected:rows.length,variants,locations,start,end});
  console.log(JSON.stringify({status:'complete_day_present',snapshot_date:date,collected_rows:rows.length}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
  main().catch(()=>{console.error('Inventory daily snapshot failed; check mode, source access, coverage bounds and retention settings.');process.exitCode=1;});
