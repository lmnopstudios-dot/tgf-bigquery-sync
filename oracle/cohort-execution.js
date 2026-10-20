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

// Boundaries remove repeated logical expansion, not measured physical operators.
export const COHORT_BOUNDARIES=Object.freeze(['orders','ranked_orders','classified_lines','line_classification_sets','entry_matches','retention_members']);
// Eight data statements: six boundaries, aggregate CTAS and final SELECT.
// Conservatively cap each statement so even per-statement billing enforcement
// cannot multiply the existing 20 GB execution allowance.
export const COHORT_STATEMENT_BYTES='2500000000';
export function cohortExecutionPlan(sql){
  const {relations,result}=cohortRelations(sql),completed=new Set();
  const prefix=(end,root)=>{
    const candidates=relations.slice(0,end).map(r=>({...r,body:completed.has(r.name)?`SELECT * FROM _SESSION.cohort_${r.name}`:r.body}));
    const needed=new Set();
    const visit=text=>{for(const r of candidates)if(!needed.has(r.name)&&new RegExp(`\\b${r.name}\\b`).test(text)){needed.add(r.name);visit(r.body);}};
    visit(root);
    return candidates.filter(r=>needed.has(r.name)).map(r=>`${r.name} AS (${r.body})`).join(',\n');
  };
  const stages=COHORT_BOUNDARIES.map(name=>{
    const index=relations.findIndex(r=>r.name===name);if(index<0)throw Error('Not a retention query');
    const query=`WITH ${prefix(index+1,name)} SELECT * FROM ${name}`;
    completed.add(name);return {name,query};
  });
  return {stages,result:`WITH ${prefix(relations.length,result)} ${result}`};
}

/** One owned job, one transaction snapshot, no persistent destination or replay. */
export function decomposedCohortSql(sql){
  const plan=cohortExecutionPlan(sql);
  return `BEGIN TRANSACTION;
${plan.stages.map(({name,query})=>`CREATE TEMP TABLE cohort_${name} AS ${query};`).join('\n')}
CREATE TEMP TABLE cohort_result AS ${plan.result};
${plan.stages.map(({name})=>`DROP TABLE _SESSION.cohort_${name};`).join('\n')}
COMMIT TRANSACTION;
SELECT * FROM cohort_result ORDER BY cohort_rank,window_days;`;
}
