import crypto from 'node:crypto';

export const PRODUCT_CLASSIFICATION_TABLE='product_classifications';
export const PRODUCT_CLASSIFICATION_TYPES=Object.freeze(['product_group','collaboration_name','product_category']);
export const PRODUCT_CATEGORIES=Object.freeze(['ring','pendant','necklace','bracelet','chain','earrings','clothing','accessory','gift_voucher','other']);
const PROVENANCE=['human_approved','business_governed','catalogue_metadata','shopify_product_type','shopify_governed_collection','woo_taxonomy','square_catalogue','canonical_propagated'];
const token=v=>String(v||'').normalize('NFKC').trim().toLowerCase().replace(/&/g,' and ').replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'');
const id=r=>`pc_${crypto.createHash('sha256').update([r.subject_ref,r.classification_type,r.classification_value,r.provenance,r.origin_subject_ref||''].join('|')).digest('hex').slice(0,32)}`;

export function productClassificationDdl(project){return `CREATE TABLE IF NOT EXISTS \`${project}.commerce.${PRODUCT_CLASSIFICATION_TABLE}\` (
  classification_id STRING NOT NULL,
  subject_ref STRING NOT NULL,
  canonical_product_ref STRING,
  subject_grain STRING NOT NULL,
  classification_type STRING NOT NULL,
  classification_value STRING NOT NULL,
  provenance STRING NOT NULL,
  origin_subject_ref STRING,
  source_evidence JSON,
  authority STRING NOT NULL,
  confidence STRING,
  status STRING NOT NULL,
  conflict_reason STRING,
  effective_from DATE,
  effective_to DATE,
  supersedes_classification_id STRING,
  recorded_at TIMESTAMP NOT NULL,
  recorded_by STRING NOT NULL,
  reviewed_at TIMESTAMP,
  reviewed_by STRING
) CLUSTER BY classification_type,classification_value,status`}

export function validateProductClassification(row={}){
  const allowed=new Set(['classification_id','subject_ref','canonical_product_ref','subject_grain','classification_type','classification_value','provenance','origin_subject_ref','source_evidence','authority','confidence','status','conflict_reason','effective_from','effective_to','supersedes_classification_id','recorded_at','recorded_by','reviewed_at','reviewed_by']);
  for(const key of Object.keys(row))if(!allowed.has(key))throw new Error(`invalid classification field: ${key}`);
  if(!/^pc_[0-9a-f-]{8,64}$/.test(row.classification_id||''))throw new Error('invalid classification_id');
  if(!/^(?:woo|shopify|square):[^:]+:.+$/.test(row.subject_ref||''))throw new Error('subject_ref must be a governed source product reference');
  if(!['source_product','canonical_product'].includes(row.subject_grain))throw new Error('invalid subject_grain');
  if(!PRODUCT_CLASSIFICATION_TYPES.includes(row.classification_type))throw new Error('invalid classification_type');
  if(!/^[a-z][a-z0-9_]{0,127}$/.test(row.classification_value||''))throw new Error('invalid classification_value');
  if(!PROVENANCE.includes(row.provenance))throw new Error('invalid classification provenance');
  if(!['human','authoritative_catalogue','governed_mapping'].includes(row.authority||({human_approved:'human',business_governed:'human',catalogue_metadata:'authoritative_catalogue',canonical_propagated:'governed_mapping'}[row.provenance])))throw new Error('invalid authority');
  if(!['high','medium','unknown',null].includes(row.confidence??null))throw new Error('invalid confidence');
  if(!['active','conflict','superseded','revoked'].includes(row.status))throw new Error('invalid status');
  for(const field of ['recorded_at','recorded_by'])if(typeof row[field]!=='string'||!row[field])throw new Error(`${field} is required`);
  return {...row};
}

/** Only structured catalogue values are interpreted. Product titles are deliberately absent. */
export function deriveCatalogueClassifications(product,{now=new Date().toISOString()}={}){
  const out=[],ref=product.source_product_ref;
  const add=(classification_type,classification_value,field,raw,provenance='catalogue_metadata')=>{const row={subject_ref:ref,canonical_product_ref:product.canonical_product_ref||null,subject_grain:'source_product',classification_type,classification_value:token(classification_value),provenance,origin_subject_ref:ref,source_evidence:{field,raw_value:typeof raw==='object'?raw:String(raw)},authority:'authoritative_catalogue',confidence:'high',status:'active',conflict_reason:null,effective_from:null,effective_to:null,supersedes_classification_id:null,recorded_at:now,recorded_by:'product-classification-sync',reviewed_at:null,reviewed_by:null};row.classification_id=id(row);out.push(row)};
  const metadata=product.metadata||{};
  const categoryFields=ref.startsWith('shopify:')?['product_type']:ref.startsWith('woo:')?['categories','category','taxonomy_product_category']:['catalogue_categories','category'];
  for(const field of categoryFields){let values=metadata[field];if(typeof values==='string'&&/^(?:\[|\")/.test(values)){try{values=JSON.parse(values)}catch{}}for(const raw of (Array.isArray(values)?values:[values]).filter(Boolean)){const value=token(typeof raw==='object'?(raw.slug||raw.name):raw);if(PRODUCT_CATEGORIES.includes(value))add('product_category',value,field,raw,ref.startsWith('shopify:')?'shopify_product_type':ref.startsWith('woo:')?'woo_taxonomy':'square_catalogue')}}
  for(const governed of metadata.governed_collaborations||[]){add('product_group','collaboration','governed_collection',governed,'shopify_governed_collection');if(governed.classification_value)add('collaboration_name',governed.classification_value,'governed_collection',governed,'shopify_governed_collection')}
  for(const raw of metadata.taxonomy_collaborations||[]){const value=token(typeof raw==='object'?(raw.slug||raw.name):raw);if(value){add('product_group','collaboration','taxonomy_collaborations',raw,'woo_taxonomy');add('collaboration_name',value,'taxonomy_collaborations',raw,'woo_taxonomy')}}
  return [...new Map(out.map(r=>[`${r.classification_type}|${r.classification_value}`,r])).values()];
}

export function materializeClassifications(products,{human=[],mappingEdges=[],now=new Date().toISOString()}={}){
  const direct=[...products.flatMap(p=>deriveCatalogueClassifications(p,{now})),...human.filter(r=>r.status==='active').map(validateProductClassification)];
  const adjacency=new Map();for(const e of mappingEdges){if(e.conflicted||e.status!=='approved'||!['deterministic','explicit_governed_mapping'].includes(e.mapping_method))continue;for(const [a,b] of [[e.left_ref,e.right_ref],[e.right_ref,e.left_ref]]){const x=adjacency.get(a)||[];x.push(b);adjacency.set(a,x)}}
  const rows=[...direct];for(const source of direct)for(const target of adjacency.get(source.subject_ref)||[]){const row={...source,classification_id:null,subject_ref:target,provenance:'canonical_propagated',authority:'governed_mapping',origin_subject_ref:source.subject_ref,source_evidence:{mapping:'active_governed_identity',origin_evidence:source.source_evidence},recorded_at:now,recorded_by:'product-classification-sync'};row.classification_id=id(row);rows.push(row)}
  const grouped=new Map();for(const row of rows){const key=`${row.subject_ref}|${row.classification_type}`;const a=grouped.get(key)||[];a.push(row);grouped.set(key,a)}
  for(const group of grouped.values()){const values=new Set(group.map(x=>x.classification_value));if(values.size>1)for(const row of group){row.status='conflict';row.conflict_reason='contradictory active governed classifications';}}
  const precedence={human_approved:4,business_governed:4,shopify_governed_collection:3,shopify_product_type:3,woo_taxonomy:3,square_catalogue:3,catalogue_metadata:2,canonical_propagated:1};const dedup=new Map();for(const row of rows){const key=`${row.subject_ref}|${row.classification_type}|${row.classification_value}`;if(!dedup.has(key)||precedence[row.provenance]>precedence[dedup.get(key).provenance])dedup.set(key,row)}return [...dedup.values()].map(validateProductClassification);
}

export function createProductClassificationService({bigquery,project,evidenceLoader,mappingLoader}){
  const table=`${project}.commerce.${PRODUCT_CLASSIFICATION_TABLE}`;
  return {async setup(){await bigquery.query({query:productClassificationDdl(project)});},async sync(){await this.setup();const products=await evidenceLoader(),edges=mappingLoader?await mappingLoader():[],desired=materializeClassifications(products,{mappingEdges:edges});const [existing]=await bigquery.query({query:`SELECT classification_id,status FROM \`${table}\``});const byId=new Map(existing.map(x=>[x.classification_id,x]));if(desired.length)await bigquery.query({query:`MERGE \`${table}\` t USING (SELECT * FROM UNNEST(@rows)) s ON t.classification_id=s.classification_id WHEN MATCHED THEN UPDATE SET status=s.status,source_evidence=s.source_evidence,conflict_reason=s.conflict_reason,recorded_at=s.recorded_at WHEN NOT MATCHED THEN INSERT ROW`,params:{rows:desired}});const counts=fn=>Object.fromEntries([...desired.reduce((m,row)=>{const key=fn(row);m.set(key,(m.get(key)||0)+1);return m},new Map())]);return {inserted:desired.filter(x=>!byId.has(x.classification_id)).length,updated:desired.filter(x=>byId.has(x.classification_id)&&byId.get(x.classification_id).status!==x.status).length,unchanged:desired.filter(x=>byId.has(x.classification_id)&&byId.get(x.classification_id).status===x.status).length,conflicts:desired.filter(x=>x.status==='conflict').length,skipped_unknown:products.length-new Set(desired.map(x=>x.subject_ref)).size,by_source:counts(row=>row.subject_ref.split(':',1)[0]),by_classification_type:counts(row=>row.classification_type),by_provenance:counts(row=>row.provenance)};}};
}
