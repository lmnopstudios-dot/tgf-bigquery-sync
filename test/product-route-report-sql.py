"""Actual generated classification/family/entry SQL on synthetic UI histories.
Requires duckdb==1.5.6/sqlglot==30.23.0. Translation is NOT BigQuery validation.
"""
import json,subprocess,duckdb,sqlglot
payload=json.loads(subprocess.check_output(['node','--input-type=module','-e',"""
import {classificationReaderCtes} from './oracle/classification-reader.js';
import {customerJourneySql} from './oracle/customer-journey.js';
import {cohortRelations} from './oracle/cohort-execution.js';
const subjects={ww:['11737','11795','23150','44905','11593'],usd:['106660','106592','106354','106178','106807']};
const refs=Object.entries(subjects).flatMap(([s,ids])=>ids.map(id=>`woo:${s}:${id}`));
const sql=customerJourneySql('fixture','retention_piece_windows',null,null,{dataset:'customer_identity',snapshot:'history-20261022-billing-v3',orderLinks:true},true);
const all=cohortRelations(sql).relations;
const names=['classification_links','classifications','classified_values','classified_lines','retention_family_candidates','retention_family_keys','retention_family_labels','retention_identity_keys','retention_reporting_lines','entry_matches'];
console.log(JSON.stringify({refs,reader:classificationReaderCtes('fixture'),parts:all.filter(r=>names.includes(r.name)).map(r=>r.name+' AS ('+r.body+')')}));
"""],text=True))
c=duckdb.connect();c.execute("ATTACH ':memory:' AS fixture");c.execute('CREATE SCHEMA fixture.commerce');c.execute('CREATE SCHEMA fixture.shopify_catalogue')
# Exact translation of the only CODE_POINTS_TO_BYTES call, [0], to one NUL byte.
c.execute("CREATE MACRO CODE_POINTS_TO_BYTES(points) AS from_hex('00')")
c.execute('CREATE TABLE fixture.commerce.product_mapping_decisions(event_id VARCHAR,decision_id VARCHAR,relationship_id VARCHAR,candidate_id VARCHAR,left_ref VARCHAR,right_ref VARCHAR,status VARCHAR,reviewed_at TIMESTAMP,supersedes_decision_id VARCHAR)')
c.execute('CREATE TABLE fixture.commerce.product_family_decisions(event_id VARCHAR,decision_id VARCHAR,membership_id VARCHAR,source_ref VARCHAR,shopify_parent_ref VARCHAR,shopify_parent_title VARCHAR,status VARCHAR,reviewed_at TIMESTAMP,supersedes_decision_id VARCHAR)')
c.execute('CREATE TABLE fixture.commerce.product_classifications(classification_id VARCHAR,subject_ref VARCHAR,classification_type VARCHAR,classification_value VARCHAR,provenance VARCHAR,status VARCHAR,effective_from DATE,effective_to DATE,supersedes_classification_id VARCHAR)')
c.execute('CREATE TABLE fixture.commerce.collection_classifications(classification_id VARCHAR,platform VARCHAR,collection_id VARCHAR,classification_type VARCHAR,classification_value VARCHAR,status VARCHAR,reviewed_at TIMESTAMP)')
c.execute('CREATE TABLE fixture.shopify_catalogue.product_collections(product_id VARCHAR,collection_id VARCHAR)')
lines=[];entries=[]
for i,ref in enumerate(payload['refs']):
 platform,store,pid=ref.split(':');target=str(100+i);name='iron_maiden' if i%5<4 else 'mot_rhead'
 # Persisted identity or family, not both. GID and numeric representations alternate.
 parent='shopify:shopify:'+('gid://shopify/Product/' if i%2 else '')+target
 if i%2:
  c.execute("INSERT INTO fixture.commerce.product_family_decisions VALUES (?,?,NULL,?,?,?,'active','2026-01-01',NULL)",[f'f{i}',f'f{i}',ref,parent,'Reviewed family'])
 else:
  c.execute("INSERT INTO fixture.commerce.product_mapping_decisions VALUES (?,?,NULL,NULL,?,?,'approved','2026-01-01',NULL)",[f'm{i}',f'm{i}',ref,parent])
 c.execute("INSERT INTO fixture.commerce.product_classifications VALUES (?,?, 'collaboration_name',?,'human_approved','active',NULL,NULL,NULL)",[f'c{i}','shopify:shopify:'+target,name])
 # Two sizes of the same parent on one entry: report must not multiply membership.
 for _ in range(2):lines.append(f"SELECT 'woo' source_platform,'{store}' source_store,'o{i}' order_ref,'{pid}' source_product_id,'{ref}' source_product_ref,'Fixture' product_title,1 units,10 line_sales,'GBP' currency")
 entries.append(f"SELECT 'c{i}' governed_customer_ref,'woo' source_platform,'{store}' source_store,'o{i}' order_ref,TIMESTAMP '2024-01-01' order_timestamp")
# An unrelated store with the same numeric ID and an unmapped variation must remain absent.
lines.extend(["SELECT 'woo','usd','missing','11737','woo:usd:11737','Unmapped',1,10,'USD'", "SELECT 'woo','ww','variation','999999','woo:ww:999999','Unmapped size',1,10,'GBP'"])
entries.extend(["SELECT 'missing','woo','usd','missing',TIMESTAMP '2024-01-01'", "SELECT 'variation','woo','ww','variation',TIMESTAMP '2024-01-01'"])
query='WITH '+payload['reader']+',source_lines AS ('+' UNION ALL '.join(lines)+'),entry_orders AS ('+' UNION ALL '.join(entries)+'),'+','.join(payload['parts'])+' SELECT * FROM entry_matches'
translated=sqlglot.transpile(query,read='bigquery',write='duckdb')[0]
params={'entry_product_ref':None,'entry_classification':'collaboration'}
rows=c.execute(translated,params).fetchall();names=[x[0] for x in c.description];result=[dict(zip(names,r)) for r in rows]
assert len(result)==10,result
assert all(r['collaboration_name'] in ('iron_maiden','mot_rhead') for r in result)
assert len({r['governed_customer_ref'] for r in result})==10
assert all(r['entry_family_status']==('governed_family' if int(r['governed_customer_ref'][1:])%2 else 'governed_product') for r in result)
print('10 WW/USD Iron Maiden/Motörhead UI-approved fixture routes consumed by actual generated classification/family/entry SQL; size lines deduplicated; unmatched store/variation excluded. DuckDB translation only.')
# Execute the exact narrow diagnostic generator on the same persisted histories.
for store in ['metorik_uk','metorik_us']:
 c.execute('CREATE SCHEMA fixture.'+store)

 for table in ['product_variations','order_line_items']:
  c.execute('CREATE TABLE fixture.'+store+'.'+table+'(product_id VARCHAR,variation_id VARCHAR,name VARCHAR,sku VARCHAR)')
audit=subprocess.check_output(['node','--input-type=module','-e',"import {uiRouteReconciliationSql} from './diagnostics/retention-ui-route-reconciliation.js';console.log(uiRouteReconciliationSql('fixture'));"],text=True)
audit_rows=c.execute(sqlglot.transpile(audit,read='bigquery',write='duckdb')[0]).fetchall()
assert audit_rows and any(r[0]=='identity_history' for r in audit_rows)
print('Exact narrow persisted-decision/current-route diagnostic also executed on translated local fixtures.')
