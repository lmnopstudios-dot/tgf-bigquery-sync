/** Split factory-owned WITH SQL without rewriting expressions or literals. */
export function cohortRelations(sql) {
  let i=sql.match(/^WITH\s+/i)?.[0].length;
  if(!i)throw Error('Expected factory WITH query');
  const relations=[];
  while(true){
    const match=sql.slice(i).match(/^\s*([a-z_]+)\s+AS\s*\(/i);
    if(!match)throw Error('Invalid factory relation');
    const name=match[1];i+=match[0].length;const start=i;let depth=1,quote=null;
    while(i<sql.length&&depth){
      const ch=sql[i++];
      if(quote){if(ch==='\\'){i++;continue;}if(ch===quote){if(sql[i]===quote)i++;else quote=null;}continue;}
      if("'\"`".includes(ch)){quote=ch;continue;}
      if(ch==='(')depth++;if(ch===')')depth--;
    }
    if(depth)throw Error('Unbalanced factory relation');
    relations.push({name,body:sql.slice(start,i-1)});
    while(/\s/.test(sql[i]||'')&&i<sql.length)i++;
    if(sql[i]!==',')return {relations,result:sql.slice(i)};
    i++;
  }
}

// Read factory-owned table references, not matching words in columns/literals.
// For example catalogue `products` is a count column, not the downstream CTE.
function relationReferences(sql){
 let masked='',quote=null;
 for(let i=0;i<sql.length;i++){
  const ch=sql[i];
  if(quote){masked+=' ';if(ch==='\\'){masked+=' ';i++;}else if(ch===quote){if(sql[i+1]===quote){masked+=' ';i++;}else quote=null;}continue;}
  if("'\"`".includes(ch)){quote=ch;masked+=' ';continue;}
  if(ch==='-'&&sql[i+1]==='-'){while(i<sql.length&&sql[i]!=='\n'){masked+=' ';i++;}masked+='\n';continue;}
  if(ch==='/'&&sql[i+1]==='*'){masked+='  ';i+=2;while(i<sql.length&&!(sql[i]==='*'&&sql[i+1]==='/')){masked+=' ';i++;}masked+='  ';i++;continue;}
  masked+=ch;
 }
 return new Set([...masked.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][a-z_0-9]*)\b/gi)].map(m=>m[1].toLowerCase()));
}

// Boundaries remove repeated logical expansion, not measured physical operators.
export const COHORT_BOUNDARIES=Object.freeze(['orders','ranked_orders','classified_lines','line_classification_sets','entry_matches','retention_members']);
// Combined catalogues reuse governance through four catalogue branches as well
// as line/family classification. Cache those shared inputs in the same snapshot.
export const COHORT_COMBINED_BOUNDARIES=Object.freeze(['orders','ranked_orders','cr_routes','cr_collection_current','cr_resolved','classified_lines','retention_reporting_lines','line_classification_sets','entry_matches','retention_members']);
// The execution-wide allowance is shared across every data statement, including
// aggregate CTAS and final SELECT. Extra boundaries cannot multiply that budget.
// Conservatively cap each statement so even per-statement billing enforcement
// cannot multiply the existing 20 GB execution allowance.
export const COHORT_EXECUTION_BYTES='20000000000';
export const COHORT_STATEMENT_BYTES='2500000000';
export function cohortExecutionPlan(sql,boundaries=null){
  const {relations,result}=cohortRelations(sql),completed=new Set();
  if(!boundaries&&(result.includes('product_journeys')||result.includes('collaboration_journeys')))boundaries=['orders','ranked_orders','cr_routes','cr_collection_current','cr_resolved','classified_lines','retention_reporting_lines','pj_members'];
  boundaries??=result.includes("'linked_tgf' population_scope")?COHORT_COMBINED_BOUNDARIES:COHORT_BOUNDARIES;
  const prefix=(end,root)=>{
    const candidates=relations.slice(0,end).map(r=>({...r,body:completed.has(r.name)?`SELECT * FROM _SESSION.cohort_${r.name}`:r.body}));
    const needed=new Set();
    const visit=text=>{const refs=relationReferences(text);for(const r of candidates)if(!needed.has(r.name)&&refs.has(r.name)){needed.add(r.name);visit(r.body);}};
    visit(root);
    return candidates.filter(r=>needed.has(r.name)).map(r=>`${r.name} AS (${r.body})`).join(',\n');
  };
  const stages=boundaries.map(name=>{
    const index=relations.findIndex(r=>r.name===name);if(index<0)throw Error('Not a retention query');
    const query=`WITH ${prefix(index+1,`SELECT * FROM ${name}`)} SELECT * FROM ${name}`;
    completed.add(name);return {name,query};
  });
  return {stages,result:`WITH ${prefix(relations.length,result)} ${result}`};
}

/** One owned job, one transaction snapshot, no persistent destination or replay. */
export function decomposedCohortSql(sql,boundaries=null){
  return cohortScript(cohortExecutionPlan(sql,boundaries));
}
function cohortScript(plan){
  return `BEGIN TRANSACTION;
${plan.stages.map(({name,query})=>`CREATE TEMP TABLE cohort_${name} AS ${query};`).join('\n')}
CREATE TEMP TABLE cohort_result AS ${plan.result};
${plan.stages.map(({name})=>`DROP TABLE _SESSION.cohort_${name};`).join('\n')}
COMMIT TRANSACTION;
SELECT * FROM cohort_result ORDER BY cohort_rank,window_days;`;
}

/** jobTimeoutMs bounds the entire script; statementTimeoutMs bounds each child.
 * Both remain subordinate to boundedQuery's remaining ownership deadline. */
export function cohortExecutionOptions(sql,timeoutMs){
 const plan=cohortExecutionPlan(sql),statementBytes=String(Math.floor(Number(COHORT_EXECUTION_BYTES)/(plan.stages.length+2)));
 return {query:cohortScript(plan),jobTimeoutMs:timeoutMs,
  scriptOptions:{statementTimeoutMs:String(Math.min(timeoutMs,15000)),statementByteBudget:statementBytes},
  maximumBytesBilled:statementBytes};
}

/** Diagnostic decomposition retains the same transaction snapshot and ownership. */
export function auditExecutionOptions(sql,boundaries,timeoutMs=20000){
 const plan=cohortExecutionPlan(sql,boundaries);
 return {query:`BEGIN TRANSACTION;
 ${plan.stages.map(({name,query})=>`CREATE TEMP TABLE cohort_${name} AS ${query};`).join('\n')}
 CREATE TEMP TABLE cohort_result AS ${plan.result};
 COMMIT TRANSACTION;
 SELECT * FROM cohort_result;`,jobTimeoutMs:timeoutMs,
 scriptOptions:{statementTimeoutMs:String(Math.min(timeoutMs,15000)),statementByteBudget:'500000000'},maximumBytesBilled:'500000000'};
}
