// Complete-item retrieval has a separate bounded aggregate budget. It never
// changes named collaboration quotas, warehouse bytes or request deadlines.
export const RETENTION_ITEM_ROWS=6000;
export const RETENTION_REPORT_ROWS=3*RETENTION_ITEM_ROWS+600;
export function itemCompleteness(rows,total,truncated=false){
 const n=Number(total);
 if(!Array.isArray(rows)||!Number.isSafeInteger(n)||n<0||n%3||rows.length>RETENTION_ITEM_ROWS||rows.length>n||rows.length%3||Boolean(truncated)!==(n>rows.length))throw Error('Invalid item completeness');
 const windows=new Map();
 for(const r of rows){if(!r.entry_product_ref)throw Error('Invalid item completeness');const key=JSON.stringify([r.source_platform,r.source_store,r.collaboration_name,r.entry_product_ref]);if(!windows.has(key))windows.set(key,new Set());const days=Number(r.window_days);if(![90,180,360].includes(days)||windows.get(key).has(days))throw Error('Invalid item completeness');windows.get(key).add(days);}
 if([...windows.values()].some(w=>w.size!==3))throw Error('Invalid item completeness');
 return {total_rows:n,returned_rows:rows.length,total_items:n/3,returned_items:rows.length/3,complete:n===rows.length};
}
export function assertItemOutcomeCompleteness(e){
 const rows=e.rows||[];if(rows.length>RETENTION_REPORT_ROWS)throw Error('Retention row bound exceeded');
 const scopes=new Set();let proved=0;
 for(const o of e.source_outcomes||[]){if(o.group!=='retention_piece_windows'||o.state!=='fulfilled'||!o.item_completeness)continue;
 const scope=JSON.stringify([o.source_platform,o.source_store]);if(scopes.has(scope))throw Error('Duplicate item completeness');scopes.add(scope);
 const part=rows.filter(r=>r.entry_product_ref&&r.source_platform===o.source_platform&&r.source_store===o.source_store);
 const checked=itemCompleteness(part,o.item_completeness.total_rows,o.truncated);
 if(Object.keys(checked).some(k=>checked[k]!==o.item_completeness[k])||o.returned_rows!==part.length||o.row_limit!==RETENTION_ITEM_ROWS)throw Error('Invalid item completeness');proved+=part.length;
 }
 // Legacy envelopes and ordinary provider components keep their existing bound.
 if(rows.length-proved>600)throw Error('Retention row bound exceeded');
}
