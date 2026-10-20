import {randomUUID} from 'node:crypto';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {emailState} from './email.js';

export const SOURCES = Object.freeze({
  shopify:{dataset:'shopify_data', table:'order_customers', date:'order_created_at'},
  ww:{dataset:'metorik_uk', table:'orders', date:'order_created_at', woo:'UK'},
  usd:{dataset:'metorik_us', table:'orders', date:'order_created_at', woo:'US'},
});
export const SCOPE = Object.freeze({start:'2022-09-24', end:'2026-10-19', dataset:'customer_identity', maxOrders:60000, batchSize:100, maxMs:14400000, bytes:'1000000000', mergeBytes:'100000000'});
export function identifier(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value || '')) throw Error('Invalid identifier');
  return value;
}
export const fq = (project, dataset, table) => `\`${identifier(project)}.${identifier(dataset)}.${identifier(table)}\``;
export const SCHEMA = ['source','order_id','customer_id','order_email','customer_email','order_email_normalized','customer_email_normalized','email_state','order_created_at','source_updated_at','retrieved_at'].map(name => ({name, type:name.endsWith('_at') ? 'TIMESTAMP' : 'STRING'}));
export function email(value) {
  if (value != null && (typeof value !== 'string' || value.length > 320)) throw Error('Invalid email field');
  const state = emailState(value);
  return {raw:typeof value === 'string' && value.trim() ? value.trim() : null, normalized:state.normalized, state:state.state};
}
export function identityRow(source, order, customer, now) {
  if (!Object.hasOwn(SOURCES, source)) throw Error('Invalid source');
  const shop = source === 'shopify';
  const a = email(shop ? order.email : order.billing?.email), b = email(customer?.email);
  const cid = shop ? order.customer?.id : order.customer_id;
  const wooTime = value => value ? `${value.replace(/Z$/, '')}Z` : null;
  return {
    source, order_id:String(order.id), customer_id:cid && String(cid) !== '0' ? String(cid) : null,
    order_email:a.raw, customer_email:b.raw,
    order_email_normalized:a.normalized, customer_email_normalized:b.normalized,
    email_state:a.normalized && b.normalized && a.normalized !== b.normalized ? 'conflict' :
      a.state === 'placeholder' || b.state === 'placeholder' ? 'placeholder' :
      a.normalized || b.normalized ? 'candidate' : a.raw || b.raw ? 'malformed' : 'missing',
    order_created_at:shop ? order.createdAt || null : wooTime(order.date_created_gmt),
    source_updated_at:shop ? order.updatedAt || null : wooTime(order.date_modified_gmt), retrieved_at:now,
  };
}
export function options(argv) {
  const o = {source:null, start:SCOPE.start, end:SCOPE.end, dataset:SCOPE.dataset, maxOrders:SCOPE.batchSize, apply:false};
  for (const arg of argv) {
    if (arg === '--apply') {o.apply = true; continue;}
    const match = /^--(source|start|end|dataset|max-orders)=(.+)$/.exec(arg);
    if (!match) throw Error('Invalid arguments');
    o[match[1] === 'max-orders' ? 'maxOrders' : match[1]] = match[2];
  }
  o.maxOrders = Number(o.maxOrders);
  if (!Object.hasOwn(SOURCES, o.source) || !Number.isInteger(o.maxOrders) || o.maxOrders < 1 || o.maxOrders > SCOPE.maxOrders) throw Error('Invalid bounded selection');
  for (const value of [o.start,o.end]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '') || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0,10) !== value) throw Error('Invalid dates');
  }
  if (o.start > o.end || o.start < SCOPE.start || o.end > SCOPE.end) throw Error('Dates outside proposed activation scope');
  identifier(o.dataset);
  return o;
}
export function selectionSql(project, o) {
  const s = SOURCES[o.source];
  return `SELECT DISTINCT CAST(order_id AS STRING) order_id FROM ${fq(project,s.dataset,s.table)} WHERE DATE(${s.date}) BETWEEN @start AND @end ORDER BY order_id LIMIT ${o.maxOrders + 1}`;
}
export async function retrieve({source, ids, graphql, woo, now = new Date().toISOString()}) {
  if (!Object.hasOwn(SOURCES, source) || ids.length > 500 || new Set(ids).size !== ids.length) throw Error('Invalid bounded selection');
  const rows = [], customers = new Map();
  if (source === 'shopify') {
    for (let i=0; i<ids.length; i+=50) {
      const batch = ids.slice(i,i+50);
      const data = await graphql('query IdentityOrders($ids:[ID!]!){nodes(ids:$ids){... on Order{id email createdAt updatedAt customer{id email}}}}', {ids:batch});
      if (data?.nodes?.length !== batch.length) throw Error('Incomplete Shopify response');
      for (let j=0; j<batch.length; j++) {
        const order = data.nodes[j];
        if (!order || order.id !== batch[j]) throw Error('Unresolved Shopify order');
        rows.push(identityRow(source,order,order.customer,now));
      }
    }
  } else {
    for (const id of ids) {
      if (!/^\d+$/.test(id)) throw Error('Invalid Woo order identifier');
      const order = await woo(`orders/${id}`);
      if (String(order?.id) !== id) throw Error('Unresolved Woo order');
      let customer = null;
      if (order.customer_id) {
        const cid = String(order.customer_id);
        if (!/^\d+$/.test(cid)) throw Error('Invalid Woo customer identifier');
        if (!customers.has(cid)) {
          const c = await woo(`customers/${cid}`);
          if (String(c?.id) !== cid) throw Error('Unresolved Woo customer');
          customers.set(cid,c);
        }
        customer = customers.get(cid);
      }
      rows.push(identityRow(source,order,customer,now));
    }
  }
  return rows;
}
export function evidenceMergeSql(project,dataset,stage) {
  // Preserve usable Woo evidence only when the API has no value. A changed
  // customer identity must never inherit the previous customer's address.
  const keep=(level)=>`S.source IN ('ww','usd') AND S.${level}_email IS NULL AND T.${level}_email_normalized IS NOT NULL${level==='customer'?' AND S.customer_id IS NOT DISTINCT FROM T.customer_id':''}`;
  const chosen=(level,suffix='')=>`IF(${keep(level)},T.${level}_email${suffix},S.${level}_email${suffix})`;
  const a=chosen('order','_normalized'),b=chosen('customer','_normalized');
  const state=`CASE WHEN ${a} IS NOT NULL AND ${b} IS NOT NULL AND ${a}!=${b} THEN 'conflict' WHEN S.email_state='placeholder' THEN 'placeholder' WHEN ${a} IS NOT NULL OR ${b} IS NOT NULL THEN 'candidate' ELSE S.email_state END`;
  const assignments=SCHEMA.filter(f=>!['source','order_id'].includes(f.name)).map(f=>{
    const match=/^(order|customer)_email(_normalized)?$/.exec(f.name);
    return `${f.name}=${match?chosen(match[1],match[2]||''):f.name==='email_state'?state:`S.${f.name}`}`;
  });
  return `MERGE ${fq(project,dataset,'order_identity')} T USING ${fq(project,dataset,stage)} S ON T.source=S.source AND T.order_id=S.order_id WHEN MATCHED AND S.retrieved_at>=T.retrieved_at THEN UPDATE SET ${assignments.join(',')} WHEN NOT MATCHED THEN INSERT ROW`;
}
export async function store({bigquery, project, dataset, rows}) {
  if (!rows.length) return;
  const ds = bigquery.dataset(dataset), table = ds.table('order_identity');
  const [present] = await table.exists();
  if (!present) throw Error('Run explicit schema setup before enrichment');
  const stage = `_identity_${randomUUID().replaceAll('-','_')}`;
  const dir = await mkdtemp(join(tmpdir(),'identity-'));
  try {
    // Expiry is set at creation so interrupted loads cannot leave an immortal stage.
    await ds.createTable(stage,{schema:SCHEMA, expirationTime:Date.now()+3600000});
    const file = join(dir,'rows.ndjson');
    await writeFile(file,rows.map(row => JSON.stringify(row)).join('\n'),{mode:0o600});
    await ds.table(stage).load(file,{schema:{fields:SCHEMA}, sourceFormat:'NEWLINE_DELIMITED_JSON', writeDisposition:'WRITE_TRUNCATE'});
    await bigquery.query({query:evidenceMergeSql(project,dataset,stage), maximumBytesBilled:SCOPE.mergeBytes, jobTimeoutMs:20000});
  } finally {
    await ds.table(stage).delete({ignoreNotFound:true}).catch(()=>{});
    await rm(dir,{recursive:true,force:true});
  }
}
