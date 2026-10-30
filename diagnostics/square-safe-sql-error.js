// Retain SQL vocabulary and identifiers from the generated query, never data values.
const keywords=new Set(('ALL AND ANY ARRAY AS ASC ASSERT_ROWS_MODIFIED AT BETWEEN BY CASE CAST COLLATE CONTAINS CREATE CROSS CUBE CURRENT DEFAULT DEFINE DESC DISTINCT ELSE END ENUM ESCAPE EXCEPT EXCLUDE EXISTS EXTRACT FALSE FETCH FOLLOWING FOR FROM FULL GROUP GROUPING GROUPS HASH HAVING IF IGNORE IN INNER INTERSECT INTERVAL INTO IS JOIN LATERAL LEFT LIKE LIMIT LOOKUP MERGE NATURAL NEW NO NOT NULL NULLS OF ON OR ORDER OUTER OVER PARTITION PRECEDING PROTO QUALIFY RANGE RECURSIVE RESPECT RIGHT ROLLUP ROW ROWS SELECT SET SETS SOME STRUCT TABLE TABLESAMPLE THEN TO TREAT TRUE UNBOUNDED UNION UNNEST USING WHEN WHERE WINDOW WITH WITHIN BOOL BYTES DATE DATETIME FLOAT64 GEOGRAPHY INT64 JSON NUMERIC STRING TIME TIMESTAMP').split(' '));
const prose=new Set(('access denied permission permissions invalid syntax error unexpected expected keyword identifier name unrecognized not found inside column field table dataset project location at line offset argument arguments function aggregate aggregation aggregations must be is are a an the of in to for and or with from as does no matching signature operator cannot cast coerce type types supported allowed available maximum bytes billed exceeded limit resource resources quota rate billing enabled authentication credentials token request failed network timeout deadline connection refused response returned reading undefined null property properties read missing value values parameter parameters anonymous list got but end input expression expressions after before character unclosed literal illegal not enough query planning too many subqueries complex complexity memory consumed consumption peak usage total shuffle disk space cpu computation exceeded execution during this stage internal optimizer analysis maximum depth stack nested expansion multiple references resourceexceeded correlated subquery that reference other tables unless they can de-correlated decorrelated such transforming them into efficient predicate scalar expression').split(' '));
function identifiers(sql){
 const clean=String(sql||'').replace(/--[^\n]*|\/\*[\s\S]*?\*\//g,' ').replace(/(['"`])(?:\\.|(?!\1)[^\\])*?\1/g,' ');
 return new Set((clean.match(/[A-Za-z_][A-Za-z0-9_]*/g)||[]).map(x=>x.toLowerCase()));
}
export function sanitizeSqlMessage(input,sql=''){
 const ids=identifiers(sql);
 const safeWord=s=>keywords.has(s.toUpperCase())||prose.has(s.toLowerCase())||ids.has(s.toLowerCase());
 const token=s=>safeWord(s)?s:'[redacted]';
 let s=String(input||'').slice(0,12000).replace(/https?:\/\/[^\s]+|[^\s<>"']+@[^\s<>"']+/gi,' [redacted] ');
 s=s.replace(/(['"`])([^\n]*?)\1/g,(_all,q,body)=>{
  if(/^[A-Za-z_][A-Za-z0-9_]*$/.test(body)&&safeWord(body))return `${q}${body}${q}`;
  if(/^[(),.;*+=<>\[\]-]{1,4}$/.test(body))return `${q}${body}${q}`;
  return ' [redacted] ';
 });
 const positions=[];
 s=s.replace(/\[(\d{1,6}):(\d{1,6})\]/g,(_m,l,c)=>{positions.push(`[${l}:${c}]`);return ` SQLPOSITION${positions.length-1} `;});
 s=s.replace(/[A-Za-z_][A-Za-z0-9_]*(?:[.\/-][A-Za-z0-9_]+)*|\d+/g,t=>{
  const p=t.match(/^SQLPOSITION(\d+)$/);if(p)return positions[Number(p[1])]||'[redacted]';
  return /^\d/.test(t)?'[number]':token(t);
 });
 return s.replace(/\s+/g,' ').trim().slice(0,900);
}
export function sqlPoint(sql,line,column){
 const lines=String(sql).split('\n');const text=lines[line-1];
 if(text===undefined)return {line,column,mapped:false,total_lines:lines.length};
 const after=text.slice(column-1);const at=after.match(/^[A-Za-z_][A-Za-z0-9_]*|^./)?.[0]||null;
 return {line,column,mapped:true,total_lines:lines.length,token:at?sanitizeSqlMessage(at,sql):null,
  line_text:sanitizeSqlMessage(text,sql)};
}
export function safeSqlFailure(error,sql=''){
 const nested=error?.response?.data?.error;
 const src=error?.errors?.[0]||nested?.errors?.[0]||nested||error||{};
 const message=String(src.message||error?.message||'');const p=message.match(/\[(\d{1,6}):(\d{1,6})\]/);
 const code=error?.code??nested?.code??error?.cause?.code;
 const reasons=new Set(['invalidQuery','invalid','notFound','accessDenied','billingNotEnabled','bytesBilledLimitExceeded','billingTierLimitExceeded','resourcesExceeded','quotaExceeded','rateLimitExceeded','backendError','internalError','jobTimeout','stopped']);
 const category=src.reason==='resourcesExceeded'?(/planning|too many subqueries|too complex/i.test(message)?'query_planning_complexity':/memory/i.test(message)?'query_memory_resource':/shuffle/i.test(message)?'query_shuffle_resource':'resource_exceeded_unspecified'):/correlated subquer|subquer.*de.?correlat/i.test(message)?'unsupported_correlated_subquery':/subquer.*not supported/i.test(message)?'unsupported_subquery':/Syntax error|Unexpected keyword|Expected .*got/i.test(message)?'sql_syntax':/Unrecognized name|not found inside/i.test(message)?'schema_field_missing':/No matching signature|Cannot cast|Cannot coerce/i.test(message)?'type_mismatch':src.reason==='accessDenied'?'access_denied':['EPERM','EACCES','ENOTFOUND','ETIMEDOUT'].includes(code)?'network_or_runtime':src.reason?'provider_error':'local_or_unknown';
 return {error_category:category,code:typeof code==='number'||['EPERM','EACCES','ENOTFOUND','ETIMEDOUT'].includes(code)?code:null,
  bigquery_reason:reasons.has(src.reason)?src.reason:src.reason?'other':null,
  sql_location:p?{line:Number(p[1]),column:Number(p[2])}:null,
  sql_context:p?sqlPoint(sql,Number(p[1]),Number(p[2])):null,
  provider_message_sanitized:sanitizeSqlMessage(message,sql)};
}
