"""Supplemental local execution of generated BigQuery SQL; not warehouse validation."""
import json,subprocess,re,sys
import duckdb,sqlglot
source="""import {collaborationJourneySqlFixture} from './test/helpers/collaboration-journey-sql-fixture.js';console.log(JSON.stringify(collaborationJourneySqlFixture(process.argv[1]==='empty')));"""
for empty in [False,True]:
 f=json.loads(subprocess.check_output(['node','--input-type=module','-e',source,'empty' if empty else 'populated'],text=True))
 q=sqlglot.transpile(f['query'],read='bigquery',write='duckdb')[0]
 # SQLGlot leaves anonymous star structs unsupported in DuckDB. Spell out the
 # real pj_totals fields without changing expressions or cohort membership.
 total_fields=['entry_product_ref','entry_product','entry_is_sizer','entry_rank','window_days','entry_customers','returning_customers','age_eligible_customers','age_repeat_customers','verified_customers','verified_repeat_customers']
 q=q.replace("'_0': t.*",','.join("'"+c+"': t."+c for c in total_fields))
 for key in ['cohort_entry_start','cohort_entry_end','observation_end','coverage_start','coverage_end']:
  q=re.sub(r'\$'+key+r'\b',f'CAST(${key} AS DATE)',q)
 used=set(re.findall(r'\$([A-Za-z_][A-Za-z_0-9]*)',q));params={k:v for k,v in f['params'].items() if k in used}
 con=duckdb.connect();r=con.execute(q,params);result=dict(zip([c[0] for c in r.description],r.fetchone()))
 rows=result['collaboration_journeys']
 def row(component,days=0,name=None,product=None):
  return next(r for r in rows if r['cohort_type']==component and r['window_days']==days and r['collaboration_name']==name and r['collaboration_product_ref']==product)
 def product(r,ref): return next(p for p in r['products'] if p['product_ref']==ref)
 if empty:
  assert len(rows)==4 and all(r['entry_customers']==0 and r['returning_customers']==0 and r['products']==[] for r in rows),rows
 else:
  overall=row('overall');assert overall['entry_customers']==5,overall # c1/c2/c6/c7/c9; overlapping memberships are not added
  assert overall['returning_customers']==4,overall
  assert product(overall,'family:CORE')['customers']==2,overall
  assert product(overall,'family:A')['customers']==1
  assert product(overall,'family:OTHER')['customers']==2
  assert not any(p['product_ref'] in ['family:LATER','family:TIED'] for p in overall['products'])
  assert overall['missing_line_customers']==1 and overall['unknown_product_customers']==1
  assert row('overall',90)['returning_customers']==3
  alpha=row('collaboration',name='alpha');beta=row('collaboration',name='beta')
  assert alpha['entry_customers']==4 and beta['entry_customers']==2
  assert alpha['entry_customers']+beta['entry_customers']>overall['entry_customers']
  assert row('item',name='alpha',product='family:A')['entry_customers']==4
  assert row('item',name='alpha',product='family:B')['entry_customers']==1
  assert all(p['denominator_customers']==r['returning_customers'] and abs(p['percentage']-100*p['customers']/r['returning_customers'])<1e-7 for r in rows for p in r['products'])
  assert all(r['verified_customers']==0 and r['verified_repeat_customers']==0 for r in rows)
 print(json.dumps({'synthetic':True,'empty':empty,'rows':len(rows),'warehouse_verified':False}))
 if not empty:open('/tmp/collaboration-generated-result.json','w').write(json.dumps(result))
