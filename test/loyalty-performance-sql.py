"""Execute the generated read-only BigQuery loyalty SQL on synthetic rows."""
import json,re,sys,datetime,duckdb,sqlglot
from sqlglot import exp
p=json.load(sys.stdin);c=duckdb.connect()
schemas={
 'customer_snapshots':'program_id VARCHAR,customer_ref_id VARCHAR,shopify_customer_gid VARCHAR,enrolled BOOLEAN,guest BOOLEAN,blocked BOOLEAN,approved BIGINT,pending BIGINT,tier_name VARCHAR,run_id VARCHAR,enrolled_at TIMESTAMPTZ',
 'points_transactions':'program_id VARCHAR,transaction_id VARCHAR,customer_ref_id VARCHAR,shopify_customer_gid VARCHAR,shopify_order_gid VARCHAR,created_at TIMESTAMPTZ,resource VARCHAR,approved_delta BIGINT,pending_delta BIGINT,run_id VARCHAR',
 'reward_claim_observations':'program_id VARCHAR,claim_id VARCHAR,customer_ref_id VARCHAR,claimed_at TIMESTAMPTZ,point_cost BIGINT,reward_kind VARCHAR,observed_at TIMESTAMPTZ,run_id VARCHAR',
 'order_customers':'order_id VARCHAR,customer_id VARCHAR,display_financial_status VARCHAR,cancelled_at TIMESTAMPTZ,synced_at TIMESTAMPTZ',
 'order_financials':'order_id VARCHAR,original_total_shop DECIMAL(18,2),total_refunded_shop DECIMAL(18,2),presentment_currency VARCHAR,cancelled_at TIMESTAMPTZ,synced_at TIMESTAMPTZ,created_at TIMESTAMPTZ,original_total_presentment DECIMAL(18,2),total_refunded_presentment DECIMAL(18,2)',
 'order_locations':'order_id VARCHAR,source_app_id VARCHAR,created_at TIMESTAMPTZ,retail_location_id VARCHAR,order_source VARCHAR,synced_at TIMESTAMPTZ'
}
for name,schema in schemas.items():
 c.execute(f'CREATE TABLE {name}({schema})')
 for row in p['tables'].get(name,[]):c.execute(f'INSERT INTO {name} VALUES ({",".join("?" for _ in row)})',row)
def convert(sql):
 sql=re.sub(r'`fixture\.(?:loyaltylion|shopify_data)\.([a-z_]+)`',r'\1',sql)
 tree=sqlglot.parse_one(sql,read='bigquery')
 def rewrite(n):
  if isinstance(n,exp.Parameter):
   v=p['params'][n.name]
   if isinstance(v,list):return exp.Cast(this=exp.Array(expressions=[exp.convert(x) for x in v]),to=exp.DataType.build('VARCHAR[]',dialect='duckdb'))
   return exp.convert(v)
  if isinstance(n,exp.CountIf):return exp.Coalesce(this=n.copy(),expressions=[exp.Literal.number(0)])
  return n
 return tree.transform(rewrite).sql(dialect='duckdb')
result={}
for name,sql in p['queries'].items():
 q=convert(sql)
 try:
  r=c.execute(q);result[name]=[dict(zip([x[0] for x in r.description],row)) for row in r.fetchall()]
 except Exception as e:raise RuntimeError(name+' '+str(e)+' SQL:'+q) from e
print(json.dumps(result,default=str))
