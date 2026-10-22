# Execute factory supplemental aggregates; this is not a BigQuery schema check.
import sqlite3,json,sys
p=json.load(sys.stdin);c=sqlite3.connect(':memory:');c.row_factory=sqlite3.Row
c.executescript('''CREATE TABLE entry_orders(governed_customer_ref,source_platform,source_store,order_ref,order_timestamp);
CREATE TABLE classified_lines(source_platform,source_store,order_ref,source_product_ref,product_title,source_product_id);
CREATE TABLE retention_next_orders(governed_customer_ref,order_timestamp);''')
c.executemany('INSERT INTO entry_orders VALUES(?,?,?,?,?)',p['entries'])
c.executemany('INSERT INTO classified_lines VALUES(?,?,?,?,?,?)',p['lines'])
c.executemany('INSERT INTO retention_next_orders VALUES(?,?)',p['returns'])
c.create_function('IF',3,lambda a,b,d:b if a else d)
class Median:
 def __init__(self):self.items=[]
 def step(self,v):
  if v is not None:self.items.append(v)
 def inverse(self,v):
  if v is not None:self.items.remove(v)
 def value(self):
  a=sorted(self.items);return (a[(len(a)-1)//2]+a[len(a)//2])/2 if a else None
 def finalize(self):return self.value()
c.create_window_function('median',1,Median)
print(json.dumps([dict(r) for r in c.execute(p['sql'],p['params'])]))
