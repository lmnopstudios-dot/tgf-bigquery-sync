"""Actual saved decision payload → shared reader → combined retention CTEs.
Local DuckDB/SQLGlot execution is not live BigQuery validation.
Run: PYTHONPATH=/path/to/duckdb-and-sqlglot python3 test/historical-collaboration-sql.py
"""
import json,subprocess,re
import duckdb,sqlglot
node=r"""
import {historicalFixture} from './test/helpers/historical-collaboration-fixture.js';
import {historicalCollaborationRequest} from './public/oracle/historical-collaboration.js';
import {historicalClassificationReadSql} from './oracle/historical-collaboration.js';
import {classificationReaderCtes} from './oracle/classification-reader.js';
import {customerJourneySql} from './oracle/customer-journey.js';
import {cohortRelations} from './oracle/cohort-execution.js';
import {PRODUCT_MAPPING_SCHEMA,PRODUCT_FAMILY_SCHEMA} from './oracle/product-mapping.js';
const f=historicalFixture(),data=await f.service.list({inventory:'all'});await f.service.save(historicalCollaborationRequest(data.items,data.collaborations[0]),'Fixture reviewer');
const {relations}=cohortRelations(customerJourneySql('fixture','retention_windows',null,null,{dataset:'customer_identity',snapshot:'fixture',orderLinks:true},true));
const names=['ranked_orders','entry_orders','classification_links','classifications','classified_values','classified_lines','retention_family_candidates','retention_family_keys','retention_family_labels','retention_identity_keys','retention_reporting_lines','line_classification_sets','raw_order_classification_sets','order_classification_sets','entry_matches','retention_next_orders','retention_members','retention_with_medians','retention_totals'];
console.log(JSON.stringify({rows:f.state.rows,read:historicalClassificationReadSql('fixture'),shared:classificationReaderCtes('fixture'),parts:names.map(name=>{const r=relations.find(r=>r.name===name);if(!r)throw Error(name);return `${r.name} AS (${r.body})`;}),mappingSchema:PRODUCT_MAPPING_SCHEMA,familySchema:PRODUCT_FAMILY_SCHEMA}));
"""
a=json.loads(subprocess.check_output(['node','--input-type=module','-e',node],text=True))
c=duckdb.connect();c.execute("ATTACH ':memory:' AS fixture")
for schema in ['commerce','shopify_catalogue']:c.execute('CREATE SCHEMA fixture.'+schema)
def create_schema(table,spec):
 c.execute('CREATE TABLE fixture.commerce.'+table+'('+','.join(s.replace(':',' ').replace('STRING','VARCHAR').replace('FLOAT64','DOUBLE').replace('INTEGER','BIGINT') for s in spec)+')')
create_schema('product_mapping_decisions',a['mappingSchema']);create_schema('product_family_decisions',a['familySchema'])
# A direct Woo classification does not need a product identity or reporting-family edge.
c.execute('CREATE TABLE fixture.commerce.product_classifications(classification_id VARCHAR,subject_ref VARCHAR,classification_type VARCHAR,classification_value VARCHAR,provenance VARCHAR,status VARCHAR,effective_from DATE,effective_to DATE,supersedes_classification_id VARCHAR,source_evidence JSON,reviewed_at TIMESTAMP)')
for row in a['rows']:
 c.execute('INSERT INTO fixture.commerce.product_classifications VALUES (?,?,?,?,?,?,?,?,?,?,?)',[row.get(k) if k!='source_evidence' else json.dumps(row[k]) for k in ['classification_id','subject_ref','classification_type','classification_value','provenance','status','effective_from','effective_to','supersedes_classification_id','source_evidence','reviewed_at']])
c.execute('CREATE TABLE fixture.commerce.collection_classifications(classification_id VARCHAR,platform VARCHAR,collection_id VARCHAR,classification_type VARCHAR,classification_value VARCHAR,status VARCHAR,reviewed_at TIMESTAMP)')
c.execute("INSERT INTO fixture.commerce.collection_classifications VALUES ('group','shopify','10','collection_group','collaboration','active','2026-01-01'),('name','shopify','10','collaboration_name','alpha','active','2026-01-01')")
c.execute('CREATE TABLE fixture.shopify_catalogue.product_collections(product_id VARCHAR,collection_id VARCHAR)')
def run(sql,params=None):
 translated=sqlglot.transpile(sql,read='bigquery',write='duckdb')[0]
 # Mirror the provider's typed DATE parameters, including NULL coverage bounds.
 for field in ['cohort_entry_start','cohort_entry_end','observation_end','coverage_start','coverage_end']:
  translated=re.sub(r'\$'+field+r'\b',f'CAST(${field} AS DATE)',translated)
 used=set(re.findall(r'\$([A-Za-z_][A-Za-z_0-9]*)',translated));params={k:v for k,v in (params or {}).items() if k in used}
 cursor=c.execute(translated,params);names=[v[0] for v in cursor.description];return [dict(zip(names,row)) for row in cursor.fetchall()]
read=run(a['read'],{'refs':['woo:ww:100','woo:usd:101']})
assert len([r for r in read if r['row_kind']=='history'])==4,read
assert len([r for r in read if r['row_kind']=='evidence'])==4,read
assert not any(r['row_kind']=='conflicts' for r in read),read
# Frozen analytical customer references are synthetic upstream inputs here. The
# report's real ranking/entry/next-order logic below must still join Woo to Shopify.
inputs="""
qualifying_orders AS (
SELECT 'ww_customer' governed_customer_ref,'woo' source_platform,'ww' source_store,'ww_entry' order_ref,TIMESTAMP('2025-10-01T12:00:00Z') order_timestamp,'Online' channel
UNION ALL SELECT 'ww_customer','shopify','shopify','ww_return',TIMESTAMP('2025-11-20T12:00:00Z'),'In-store'
UNION ALL SELECT 'usd_customer','woo','usd','usd_entry',TIMESTAMP('2025-10-01T12:00:00Z'),'Online'
UNION ALL SELECT 'usd_customer','shopify','shopify','usd_return',TIMESTAMP('2025-11-20T12:00:00Z'),'Online'),
source_lines AS (
 SELECT 'woo' source_platform,'ww' source_store,'ww_entry' order_ref,'100' source_product_id,'woo:ww:100' source_product_ref,'Archived WW product' product_title
 UNION ALL SELECT 'woo','usd','usd_entry','101','woo:usd:101','Archived USD product'
 UNION ALL SELECT 'shopify','shopify','ww_return','900','shopify:shopify:900','Later purchase'
 UNION ALL SELECT 'shopify','shopify','usd_return','900','shopify:shopify:900','Later purchase')
"""
sql='WITH '+a['shared']+','+inputs+','+','.join(a['parts'])+' SELECT * FROM retention_totals ORDER BY window_days'
params={'time_zone':'Europe/London','cohort_entry_start':'2022-10-19','cohort_entry_end':'2026-10-19','entry_source':None,'entry_channel':None,'entry_product_ref':None,'entry_classification':'collaboration','minimum_sequence':2,'maximum_sequence':None,'within_days':None,'subsequent_source':None,'subsequent_channel':None,'observation_end':'2026-10-19','coverage_start':None,'coverage_end':None,'coverage_status':'unverified','coverage_evidence':None}
rows=run(sql,params)
assert len(rows)==3,rows
for row in rows:
 assert row['source_platform']=='tgf' and row['source_store']=='combined' and row['collaboration_name']=='alpha',row
 assert row['cohort_customers']==2 and row['observed_repeat_customers']==2 and row['provisional_eligible_customers']==2 and row['provisional_repeat_rate']==1,row
 assert row['mature_customers']==0 and row['repeat_customers']==0 and row['observation_coverage_status']=='unverified',row
assert c.execute('SELECT COUNT(*) FROM fixture.commerce.product_mapping_decisions').fetchone()[0]==0
assert c.execute('SELECT COUNT(*) FROM fixture.commerce.product_family_decisions').fetchone()[0]==0
print(json.dumps({'classification_read':'executed','real_combined_retention_ctes':'executed','woo_entries':2,'shopify_returns':2,'windows':[r['window_days'] for r in rows],'shopify_equivalents_required':False,'verified_coverage_fabricated':False,'live_bigquery_verified':False}))
