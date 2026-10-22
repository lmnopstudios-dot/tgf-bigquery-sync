# Execute factory supplemental aggregates; this is not a BigQuery schema check.
import sqlite3,json,sys,re
from datetime import datetime
from zoneinfo import ZoneInfo
p=json.load(sys.stdin);c=sqlite3.connect(':memory:');c.row_factory=sqlite3.Row
c.executescript('''CREATE TABLE entry_orders(governed_customer_ref,source_platform,source_store,order_ref,order_timestamp);
CREATE TABLE classified_lines(source_platform,source_store,order_ref,source_product_ref,product_title,source_product_id);
CREATE TABLE retention_next_orders(governed_customer_ref,order_timestamp);''')
c.executemany('INSERT INTO entry_orders VALUES(?,?,?,?,?)',p['entries'])
c.executemany('INSERT INTO classified_lines VALUES(?,?,?,?,?,?)',p['lines'])
c.executemany('INSERT INTO retention_next_orders VALUES(?,?)',p['returns'])
c.create_function('IF',3,lambda a,b,d:b if a else d)
c.create_function('LD',1,lambda x:None if x is None else datetime.fromisoformat(x.replace('Z','+00:00')).astimezone(ZoneInfo('Europe/London')).date().isoformat())
c.create_function('STARTS_WITH',2,lambda a,b:bool(a and a.startswith(b)))
c.create_function('REGEXP_CONTAINS',2,lambda a,b:bool(a and re.search(b,a)))
c.create_function('REGEXP_EXTRACT',2,lambda a,b:re.search(b,a).group(1) if a and re.search(b,a) else None)
c.create_function('CONCAT',-1,lambda *v:None if None in v else ''.join(str(x) for x in v))
c.executescript('CREATE TABLE cr_identity(source_ref,classification_ref); CREATE TABLE cr_routes(source_ref,classification_ref,mapping_type); CREATE TABLE cr_family(source_ref,classification_ref); CREATE TABLE cr_family_current(shopify_parent_ref,shopify_parent_title,status);')
c.execute('CREATE TABLE retention_members(source_platform,source_store,collaboration_name,window_days,governed_customer_ref,mature,second_source_platform,second_source_store,second_order_ref,days_to_second)')
c.executemany('INSERT INTO retention_members VALUES(?,?,?,?,?,?,?,?,?,?)',p.get('members',[]))
g=p.get('governed',{})
c.executemany('INSERT INTO cr_routes VALUES(?,?,?)',g.get('routes',[]))
c.executemany('INSERT INTO cr_identity VALUES(?,?)',g.get('identities',[]))
c.executemany('INSERT INTO cr_family VALUES(?,?)',g.get('families',[]))
c.executemany('INSERT INTO cr_family_current VALUES(?,?,?)',g.get('labels',[]))
c.create_function('SAFE_DIVIDE',2,lambda a,b:None if not b else a/b)
c.execute("CREATE VIEW retention_reporting_lines AS SELECT *,source_product_ref reporting_product_ref,product_title reporting_product_title,'unmapped_item' family_status FROM classified_lines")
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
