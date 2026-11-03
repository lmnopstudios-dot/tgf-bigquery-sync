"""Execute the generated resolver SQL locally; input tables alone are fixtures."""
import json,sys,duckdb,sqlglot
p=json.load(sys.stdin)
tree=sqlglot.parse_one(p['query'].replace('SAFE.PARSE_JSON(', 'SAFE_PARSE_JSON('),read='bigquery')
tree=tree.transform(lambda n:sqlglot.exp.Coalesce(this=n.copy(),expressions=[sqlglot.exp.Literal.number(0)]) if isinstance(n,sqlglot.exp.CountIf) else n)
c=duckdb.connect()
c.execute('CREATE MACRO SAFE_PARSE_JSON(x) AS TRY_CAST(x AS JSON)')
c.execute('CREATE TABLE fixture_orders(oid VARCHAR,location_id VARCHAR)')
c.executemany('INSERT INTO fixture_orders VALUES (?,?)',p['orders'])
c.execute('CREATE TABLE fixture_payments(payload JSON)')
if p['payments']: c.executemany('INSERT INTO fixture_payments VALUES (?)',[(json.dumps(r),) for r in p['payments']])
r=c.execute(tree.sql(dialect='duckdb'))
print(json.dumps([dict(zip([d[0] for d in r.description],row)) for row in r.fetchall()]))
