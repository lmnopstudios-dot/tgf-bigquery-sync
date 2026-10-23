"""Local translated execution of the generated final result; not native BigQuery."""
import json,subprocess,re
import duckdb,sqlglot
source="""import {cohortRelations} from './oracle/cohort-execution.js';import {retentionBigQueryFixture} from './test/helpers/retention-bigquery-sql-fixture.js';const f=retentionBigQueryFixture('retention_piece_windows','woo','ww',true);const {relations}=cohortRelations(f.query);console.log(JSON.stringify({...f,column_query:'WITH '+relations.map(r=>`${r.name} AS (${r.body})`).join(',')+' SELECT * FROM section_ranked LIMIT 0'}));"""
a=json.loads(subprocess.check_output(['node','--input-type=module','-e',source],text=True))
# Local dialect adapters: DuckDB lacks inline ARRAY_AGG LIMIT and SQLGlot
# cannot expand a star inside SELECT AS STRUCT. Derive the actual section
# columns from the generated CTE schema, preserving both replaced rank fields.
def execute(query):
 sql=sqlglot.transpile(query.replace('LIMIT 10) second_order_products',') second_order_products'),read='bigquery',write='duckdb')[0]
 for field in ['cohort_entry_start','cohort_entry_end','observation_end','coverage_start','coverage_end']:
  sql=re.sub(r'\$'+field+r'\b',f'CAST(${field} AS DATE)',sql)
 used=set(re.findall(r'\$([A-Za-z_][A-Za-z_0-9]*)',sql));params={k:v for k,v in a['params'].items() if k in used}
 return con.execute(sql,params)
con=duckdb.connect();schema=execute(a['column_query']);columns=[r[0] for r in schema.description]
replacement="'linked_tgf' population_scope,"+','.join(c for c in columns if c not in ['rate_rank','provisional_rate_rank'])+",IF(provisional_repeat_rate IS NULL,NULL,provisional_rate_rank) provisional_rate_rank,IF(mature_customers=0,NULL,rate_rank) rate_rank"
query=re.sub(r"'linked_tgf' population_scope,\* REPLACE\(.*? AS rate_rank\)",replacement,a['query'])
# DuckDB resolves unqualified ARRAY ordering against the outer row; qualify local source keys.
query=query.replace('ORDER BY source_platform,source_store,collaboration_name,window_days LIMIT 300','ORDER BY entry_source_platform,entry_source_store,retention_members.collaboration_name,retention_members.window_days LIMIT 300')
c=execute(query);cols=[r[0] for r in c.description];rows=[dict(zip(cols,r)) for r in c.fetchall()]
assert len(rows)==3,rows
assert {r['window_days'] for r in rows}=={90,180,360}
headers=[r for r in rows if r['window_days']==90]
assert len(headers)==1
for field in ['coverage','entry_platform_rows','product_ranking_rows']:
 assert headers[0][field],field
 assert all(not r[field] for r in rows if r['window_days']!=90),field
assert all(r['population_scope']=='linked_tgf' and r['cohort_customers']==1 for r in rows)
assert all(r['total_item_window_rows']==3 for r in rows)
assert all(r['second_order_product_coverage']['unidentified_product_customers']==1 for r in rows)
print(json.dumps({'generated_compact_result':'executed','windows':3,'metadata_rows':1,'item_counts_unchanged':True,'unknown_attribution_preserved':True,'live_bigquery_verified':False}))
