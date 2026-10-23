"""Execute actual generated ranking/selection CTEs locally; not live BigQuery."""
import json,subprocess,re
import duckdb,sqlglot
source=r"""
import {customerJourneySql} from './oracle/customer-journey.js';import {cohortRelations} from './oracle/cohort-execution.js';
const {relations,result}=cohortRelations(customerJourneySql('fixture','retention_piece_windows',null,null,{dataset:'customer_identity',snapshot:'fixture',orderLinks:true},true));
const suffix=['retention_scored','retention_fair','retention_ranked'].map(n=>{const r=relations.find(r=>r.name===n);return `${n} AS (${r.body})`;}).join(',');
const select=result.match(/FROM \((SELECT \* FROM retention_ranked[\s\S]*? LIMIT @limit)\) r/)[1];console.log(JSON.stringify({suffix,select}));
"""
a=json.loads(subprocess.check_output(['node','--input-type=module','-e',source],text=True))
inputs="""retention_totals AS (SELECT 'tgf' source_platform,'combined' source_store,'alpha' collaboration_name,CONCAT('p',CAST(n AS STRING)) entry_product_ref,window_days,0 repeat_customers,0 mature_customers FROM UNNEST(GENERATE_ARRAY(1,240)) n CROSS JOIN UNNEST([90,180,360]) window_days)"""
sql='WITH '+inputs+','+a['suffix']+' '+a['select']
translated=sqlglot.transpile(sql,read='bigquery',write='duckdb')[0]
con=duckdb.connect()
params={'ranking_window':90,'retention_sort':'repeat_rate_desc','cohort_limit':2000,'retention_store_count':1,'limit':6000}
c=con.execute(translated,params);columns=[r[0] for r in c.description];rows=[dict(zip(columns,r)) for r in c.fetchall()]
assert len(rows)==720,len(rows)
assert len(set(r['entry_product_ref'] for r in rows))==240
assert all(r['total_item_window_rows']==720 and not r['truncated'] for r in rows)
params.update({'cohort_limit':33,'limit':99});c=con.execute(translated,params);old=[dict(zip(columns,r)) for r in c.fetchall()]
assert len(old)==99 and all(r['truncated'] and r['total_item_window_rows']==720 for r in old)
print(json.dumps({'actual_generated_selection':'executed','all_items':240,'window_rows':720,'old_limit_rows':99,'production_execution_verified':False}))
