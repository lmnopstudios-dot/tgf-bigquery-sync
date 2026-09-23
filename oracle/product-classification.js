export const PRODUCT_CLASSIFICATION_TABLE='product_classifications';
export const PRODUCT_CLASSIFICATION_TYPES=Object.freeze(['product_group','product_category','material']);

export function productClassificationDdl(project){return `CREATE TABLE IF NOT EXISTS \`${project}.commerce.${PRODUCT_CLASSIFICATION_TABLE}\` (
  classification_id STRING NOT NULL,
  subject_ref STRING NOT NULL,
  subject_grain STRING NOT NULL,
  classification_type STRING NOT NULL,
  classification_value STRING NOT NULL,
  provenance STRING NOT NULL,
  confidence STRING,
  status STRING NOT NULL,
  effective_from DATE,
  effective_to DATE,
  recorded_at TIMESTAMP NOT NULL,
  recorded_by STRING NOT NULL
) CLUSTER BY classification_type,classification_value,status`}

export function validateProductClassification(row={}){
  const allowed=new Set(['classification_id','subject_ref','subject_grain','classification_type','classification_value','provenance','confidence','status','effective_from','effective_to','recorded_at','recorded_by']);
  for(const key of Object.keys(row))if(!allowed.has(key))throw new Error(`invalid classification field: ${key}`);
  if(!/^pc_[0-9a-f-]{8,64}$/.test(row.classification_id||''))throw new Error('invalid classification_id');
  if(!/^(?:woo|shopify|square):[^:]+:.+$/.test(row.subject_ref||''))throw new Error('subject_ref must be a governed source product reference');
  if(row.subject_grain!=='source_product')throw new Error('only source_product classifications are supported');
  if(!PRODUCT_CLASSIFICATION_TYPES.includes(row.classification_type))throw new Error('invalid classification_type');
  if(!/^[a-z][a-z0-9_]{0,63}$/.test(row.classification_value||''))throw new Error('invalid classification_value');
  if(!['catalogue_metadata','business_governed','human_approved'].includes(row.provenance))throw new Error('invalid classification provenance');
  if(!['high','medium','unknown',null].includes(row.confidence??null))throw new Error('invalid confidence');
  if(!['active','superseded','revoked'].includes(row.status))throw new Error('invalid status');
  for(const field of ['recorded_at','recorded_by'])if(typeof row[field]!=='string'||!row[field])throw new Error(`${field} is required`);
  return {...row};
}
