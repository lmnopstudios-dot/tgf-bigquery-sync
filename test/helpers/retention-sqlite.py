# Executes factory-owned retention calculation relations against synthetic inputs.
# Dialect adaptation is local verification, not a BigQuery schema/dry-run proof.
import json, sqlite3, sys
p=json.load(sys.stdin)
c=sqlite3.connect(':memory:')
c.row_factory=sqlite3.Row
c.executescript('''
CREATE TABLE entry_orders(governed_customer_ref TEXT,source_platform TEXT,source_store TEXT,order_timestamp TEXT);
CREATE TABLE classified_lines(source_platform TEXT,source_store TEXT,order_ref TEXT,source_product_ref TEXT,product_title TEXT,source_product_id TEXT);
CREATE TABLE entry_matches(governed_customer_ref TEXT,source_platform TEXT,source_store TEXT,collaboration_name TEXT,entry_timestamp TEXT,entry_product_ref TEXT,entry_product_title TEXT);
CREATE TABLE retention_next_orders(governed_customer_ref TEXT,order_timestamp TEXT,order_ref TEXT,source_platform TEXT,source_store TEXT);
CREATE TABLE order_classification_sets(source_platform TEXT,source_store TEXT,order_ref TEXT,unknown_lines INTEGER,core_lines INTEGER,product_lines INTEGER,names TEXT);
''')
for row in p.get('entries',[]): c.execute('INSERT INTO entry_orders VALUES(?,?,?,?)',row)
for row in p.get('lines',[]): c.execute('INSERT INTO classified_lines VALUES(?,?,?,?,?,?)',row if len(row)==6 else row+[row[3].split(':')[-1] if row[3] else None])
for row in p['members']: c.execute('INSERT INTO entry_matches VALUES(?,?,?,?,?,?,?)',row)
for row in p['returns']: c.execute('INSERT INTO retention_next_orders VALUES(?,?,?,?,?)',row)
for row in p['classes']: c.execute('INSERT INTO order_classification_sets VALUES(?,?,?,?,?,?,?)',row)
c.create_function('IF',3,lambda a,b,d: b if a else d)
c.create_function('ARRAY_LENGTH',1,lambda a: len(json.loads(a)) if a else None)
class Median:
 def __init__(self): self.items=[]
 def step(self,v):
  if v is not None: self.items.append(v)
 def inverse(self,v):
  if v is not None: self.items.remove(v)
 def value(self):
  a=sorted(self.items)
  return (a[(len(a)-1)//2]+a[len(a)//2])/2 if a else None
 def finalize(self): return self.value()
c.create_window_function('median',1,Median)
print(json.dumps([dict(r) for r in c.execute(p['sql'],p['params'])]))
