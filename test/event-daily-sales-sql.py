"""Execute generated native-Shopify window SQL; all source rows are synthetic."""
import json,sys,duckdb,sqlglot
from sqlglot import exp
p=json.load(sys.stdin)
sql=p['query']
for name in ['order_financials','order_locations','order_refunds','order_line_items']:
 sql=sql.replace(f'`fixture.shopify_data.{name}`',f'fixture_{name}')
for ds in ['metorik_uk','metorik_us']:
 for name in ['orders','refunds_api']:
  sql=sql.replace(f'`fixture.{ds}.{name}`',f'fixture_{ds}_{name}')
tree=sqlglot.parse_one(sql.replace('SAFE.PARSE_JSON(', 'SAFE_PARSE_JSON('),read='bigquery')
def rewrite(n):
 if isinstance(n,exp.Parameter):
  v=p['params'][n.name]
  return exp.Null() if v is None else exp.Literal.string(str(v))
 if isinstance(n,exp.CountIf):return exp.Coalesce(this=n.copy(),expressions=[exp.Literal.number(0)])
 return n
tree=tree.transform(rewrite)
c=duckdb.connect();c.execute("SET TimeZone='UTC'");c.execute('CREATE MACRO SAFE_PARSE_JSON(x) AS TRY_CAST(x AS JSON)')
schemas={
 'metorik_uk_orders':'order_id STRING,order_created_at TIMESTAMP,synced_at TIMESTAMP,status STRING,total NUMERIC,currency STRING',
 'metorik_us_orders':'order_id STRING,order_created_at TIMESTAMP,synced_at TIMESTAMP,status STRING,total NUMERIC,currency STRING',
 'metorik_uk_refunds_api':'refund_id STRING,order_id STRING,synced_at TIMESTAMP,refund_amount NUMERIC,refund_date TIMESTAMP',
 'metorik_us_refunds_api':'refund_id STRING,order_id STRING,synced_at TIMESTAMP,refund_amount NUMERIC,refund_date TIMESTAMP',
 'order_financials':'order_id STRING,created_at TIMESTAMP,synced_at TIMESTAMP,cancelled_at TIMESTAMP,presentment_currency STRING,original_total_presentment NUMERIC,transactions_json STRING',
 'order_locations':'order_id STRING,synced_at TIMESTAMP,retail_location_id STRING,order_source STRING,source_app_id STRING',
 'order_refunds':'refund_id STRING,order_id STRING,synced_at TIMESTAMP,presentment_currency STRING,refund_total_presentment NUMERIC,has_successful_refund_transaction BOOLEAN,refund_created_at TIMESTAMP',
 'order_line_items':'order_id STRING,line_item_id STRING,synced_at TIMESTAMP,product_id STRING,title STRING,quantity NUMERIC,discounted_total_presentment NUMERIC,presentment_currency STRING'
}
for name,schema in schemas.items():
 c.execute(f'CREATE TABLE fixture_{name}({schema})')
 for row in p.get(name,[]):c.execute(f'INSERT INTO fixture_{name} VALUES ({",".join("?" for _ in row)})',row)
r=c.execute(tree.sql(dialect='duckdb'))
print(json.dumps([dict(zip([d[0] for d in r.description],row)) for row in r.fetchall()],default=lambda v: v.isoformat() if hasattr(v, "isoformat") else float(v)))
