/** Shared event provenance rendering; source identifiers are literal text. */
export function storedTemporal(value) {
  if(value==null)return null;
  if(value instanceof Date)return value.toISOString();
  if(typeof value==='string')return value;
  if(typeof value.value==='string')return value.value;
  return null;
}
export function provenanceCode(value) {
  return '`'+String(value??'unavailable').replaceAll('`','').replaceAll('|','\\|').replace(/[\r\n]/g,' ')+'`';
}
