"""Execute generated BigQuery session SQL with fixture JSON source tables."""
import json,sys,duckdb,sqlglot
p=json.load(sys.stdin)
sql=p['query']
for table,alias in [('orders','o'),('payments','p'),('refunds','r')]:
 sql=sql.replace(f'SELECT TO_JSON({alias},stringify_wide_numbers=>TRUE) j FROM `fixture.square_data.{table}` {alias}',f'SELECT payload j FROM fixture_{table}')
tree=sqlglot.parse_one(sql.replace('SAFE.PARSE_JSON(', 'SAFE_PARSE_JSON('),read='bigquery')
def rewrite(n):
 if isinstance(n,sqlglot.exp.Parameter):return sqlglot.exp.Literal.string(p['params'][n.name])
 if isinstance(n,sqlglot.exp.CountIf):return sqlglot.exp.Coalesce(this=n.copy(),expressions=[sqlglot.exp.Literal.number(0)])
 return n
tree=tree.transform(rewrite)
c=duckdb.connect()
c.execute('CREATE MACRO SAFE_PARSE_JSON(x) AS TRY_CAST(x AS JSON)')
for table in ['orders','payments','refunds']:
 c.execute(f'CREATE TABLE fixture_{table}(payload JSON)')
 if p.get(table):c.executemany(f'INSERT INTO fixture_{table} VALUES (?)',[(json.dumps(r),) for r in p[table]])
r=c.execute(tree.sql(dialect='duckdb'))
print(json.dumps([dict(zip([d[0] for d in r.description],row)) for row in r.fetchall()],default=float))
