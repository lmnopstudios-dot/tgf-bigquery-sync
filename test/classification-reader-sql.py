"""Execute production-generated SQL on synthetic relational fixtures.
Run with duckdb and sqlglot installed (see docs/oracle/classification-coverage.md).
Dialect translation is local verification, not BigQuery production acceptance.
"""
import json, subprocess
import duckdb, sqlglot

node = """
import {classificationReaderCtes} from './oracle/classification-reader.js';
import {classificationDiagnosticOptions} from './diagnostics/oracle-classification-coverage.js';
import {createOracleProviderDependencies} from './oracle/provider-dependencies.js';
import {retentionDefinition} from './oracle/cohort-retention.js';
import {transitionAnalysisContext} from './oracle/analysis-context.js';
import {cohortExecutionPlan} from './oracle/cohort-execution.js';
const now=Date.parse('2026-10-19T12:00:00Z');let q;
const deps=createOracleProviderDependencies({project:'fixture',bigquery:{query:async x=>{q=x;return [[]];}}});
const c=transitionAnalysisContext(null,'Rank collaborations by repeat purchase rate online in the last 3 years.',{now}).context;
const d=retentionDefinition(c);await deps.customerJourney.analyzeCustomerJourney({...d,cohort:{...d.cohort,entry_source:'woo'}},{decompose:false,sourceStore:'ww'});
const retention={...q,query:(await import('./oracle/customer-journey.js')).customerJourneySql('fixture','retention_windows','woo','ww')};await deps.customerJourney.analyzeCustomerJourney({...d,cohort:{...d.cohort,entry_source:'woo'},group_by:['retention_piece_windows']},{decompose:false,sourceStore:'ww'});const pieces=q;await deps.customerJourney.analyzeCustomerJourney({...d,cohort:{...d.cohort,entry_source:'woo'},group_by:['downstream_product'],subsequent:{...d.subsequent,product_classification:'collaboration'}},{decompose:false,sourceStore:'ww'});const downstream=q;await deps.customerJourney.analyzeCustomerJourney({...d,cohort:{...d.cohort,entry_source:'shopify'}},{decompose:false,sourceStore:'shopify'});const shopify=q;
await deps.customerJourney.analyzeCustomerJourney({...d,cohort:{...d.cohort,entry_source:'woo'}},{decompose:false,sourceStore:'usd'});const usd=q;
await deps.customerJourney.analyzeCustomerJourney({...d,cohort:{...d.cohort,entry_source:'woo'},group_by:['retention_piece_windows']},{decompose:false,sourceStore:'usd'});const usdPieces=q;
await deps.customerJourney.analyzeCustomerJourney({...d,cohort:{...d.cohort,entry_source:'shopify'},group_by:['retention_piece_windows']},{decompose:false,sourceStore:'shopify'});const shopifyPieces=q;
const diagnostics={};for(const stage of ['gaps','identity','history','keys','first-orders','subsequent','members','aggregation','full'])diagnostics[stage]=await classificationDiagnosticOptions({project:'fixture',source:'woo',store:'ww',stage,now});diagnostics.catalogue=await classificationDiagnosticOptions({project:'fixture',source:'shopify',store:'shopify',stage:'catalogue',now});
const plans=Object.fromEntries(Object.entries({retention,pieces,shopify,usd,usdPieces,shopifyPieces}).map(([k,v])=>[k,cohortExecutionPlan(v.query)]));
console.log(JSON.stringify({plans,diagnostics,pieces,shopify,usd,usdPieces,shopifyPieces,downstream,shared:'WITH '+classificationReaderCtes('fixture')+' SELECT * FROM cr_resolved',retention,stages:await classificationDiagnosticOptions({project:'fixture',source:'woo',store:'ww',stage:'stages',now})}));
"""
queries=json.loads(subprocess.check_output(['node','--input-type=module','-e',node],text=True))
c=duckdb.connect();c.execute("ATTACH ':memory:' AS fixture")
for schema in ['commerce','shopify_catalogue','shopify_data','metorik_uk']:c.execute('CREATE SCHEMA fixture.'+schema)
c.execute('CREATE TABLE fixture.commerce.product_mapping_decisions(event_id VARCHAR,decision_id VARCHAR,relationship_id VARCHAR,candidate_id VARCHAR,left_ref VARCHAR,right_ref VARCHAR,status VARCHAR,reviewed_at TIMESTAMP,supersedes_decision_id VARCHAR)')
c.execute("INSERT INTO fixture.commerce.product_mapping_decisions VALUES ('m1','m1','r1',NULL,'woo:ww:1','shopify:shopify:100','approved','2025-01-01',NULL),('m2','m2','r2',NULL,'woo:ww:3','shopify:shopify:100','approved','2025-01-01',NULL),('m3','m3','r2',NULL,'woo:ww:3','shopify:shopify:100','revoked','2026-01-01','m2')")
c.execute('CREATE TABLE fixture.commerce.product_family_decisions(event_id VARCHAR,decision_id VARCHAR,membership_id VARCHAR,source_ref VARCHAR,shopify_parent_ref VARCHAR,status VARCHAR,reviewed_at TIMESTAMP,supersedes_decision_id VARCHAR)')
c.execute("INSERT INTO fixture.commerce.product_family_decisions VALUES ('f1','f1','f1','woo:ww:2','shopify:shopify:gid://shopify/Product/101','active','2025-01-01',NULL)")
c.execute('CREATE TABLE fixture.commerce.product_classifications(classification_id VARCHAR,subject_ref VARCHAR,classification_type VARCHAR,classification_value VARCHAR,provenance VARCHAR,status VARCHAR,effective_from DATE,effective_to DATE,supersedes_classification_id VARCHAR)')
product=[('p4','woo:ww:4','product_group','core','human_approved','active'),('p5a','woo:ww:5','collaboration_name','alpha','human_approved','conflict'),('p5b','woo:ww:5','collaboration_name','beta','human_approved','conflict'),('p6','woo:ww:6','product_group','collaboration','human_approved','active'),('p8a','woo:ww:8','product_group','core','human_approved','active'),('p8b','woo:ww:8','collaboration_name','gamma','human_approved','active'),('stale','shopify:shopify:103','collaboration_name','stale','shopify_governed_collection','active'),('variant','shopify:shopify:gid://shopify/ProductVariant/100','collaboration_name','wrong_variant','human_approved','active')]
c.executemany('INSERT INTO fixture.commerce.product_classifications VALUES (?,?,?,?,?,?,NULL,NULL,NULL)',product)
c.execute("INSERT INTO fixture.commerce.product_classifications VALUES ('future','woo:ww:1','collaboration_name','future_name','human_approved','active','2099-01-01',NULL,NULL),('expired','woo:ww:1','collaboration_name','expired_name','human_approved','active',NULL,'2000-01-01',NULL)")
c.execute('CREATE TABLE fixture.commerce.collection_classifications(classification_id VARCHAR,platform VARCHAR,collection_id VARCHAR,classification_type VARCHAR,classification_value VARCHAR,status VARCHAR,reviewed_at TIMESTAMP)')
c.execute("INSERT INTO fixture.commerce.collection_classifications VALUES ('c0','shopify','10','collaboration_name','old_name','active','2025-01-01'),('c1','shopify','10','collaboration_name','alpha','active','2026-01-01'),('c2','shopify','11','collaboration_name','beta','active','2026-01-01'),('c3','shopify','12','collection_group','collaboration','active','2026-01-01'),('c4','shopify','13','collaboration_name','stale','revoked','2026-01-01')")
c.execute('CREATE TABLE fixture.shopify_catalogue.product_collections(product_id VARCHAR,collection_id VARCHAR)')
c.execute("INSERT INTO fixture.shopify_catalogue.product_collections VALUES ('100','10'),('101','11'),('102','12'),('103','13')")

def records(cursor):
    names=[column[0] for column in cursor.description]
    return [dict(zip(names,row)) for row in cursor.fetchall()]

def execute(query,params=None):
    translated=sqlglot.transpile(query,read='bigquery',write='duckdb')[0]
    return records(c.execute(translated,params or {}))
shared=execute(queries['shared'])
assert any(r['subject_ref']=='woo:ww:1' and r['classification_value']=='alpha' for r in shared)
assert any(r['subject_ref']=='woo:ww:2' and r['classification_value']=='beta' for r in shared)
assert not any(r['subject_ref'] in ['woo:ww:3','woo:usd:1','woo:ww:5'] for r in shared)
assert not any(r['classification_value'] in ['stale','old_name','wrong_variant','gamma','future_name','expired_name'] for r in shared)
c.execute('CREATE TABLE fixture.metorik_uk.orders(order_id BIGINT,customer_id BIGINT,order_created_at TIMESTAMP,status VARCHAR,currency VARCHAR,total DOUBLE,total_refunds DOUBLE)')
c.execute('CREATE TABLE fixture.metorik_uk.order_line_items(order_id BIGINT,product_id BIGINT,variation_id BIGINT,name VARCHAR,quantity INT,total DOUBLE,currency VARCHAR)')
events=[(1,1,'2025-01-01',1),(2,1,'2025-01-31',4),(3,2,'2025-01-01',2),(4,2,'2025-05-01',1),(5,3,'2025-01-01',99),(6,4,'2025-01-01',6),(7,5,'2025-01-01',5),(8,6,'2025-01-01',3),(9,7,'2025-01-01',8),(10,8,'2026-10-01',1),(11,None,'2025-01-01',1),(12,9,'2025-01-01',0)]
for order,customer,when,product in events:
 c.execute("INSERT INTO fixture.metorik_uk.orders VALUES (?,?,?,'completed','GBP',100,0)",[order,customer,when]);c.execute("INSERT INTO fixture.metorik_uk.order_line_items VALUES (?,?,900, 'Synthetic variant option',1,100,'GBP')",[order,product])

def run(options):
 sql=sqlglot.transpile(options['query'],read='bigquery',write='duckdb')[0]
 params={k:(v['value'] if isinstance(v,dict) and 'value' in v else v) for k,v in options['params'].items()}
 # DuckDB rejects unused named parameters; BigQuery accepts them.
 import re
 used=set(re.findall(r'\$([A-Za-z_][A-Za-z_0-9]*)',sql));params={k:v for k,v in params.items() if k in used}
 return records(c.execute(sql,params))
stages=run(queries['stages']);counts={r['collaboration_state']:int(r['product_lines']) for r in stages}
assert counts=={'named':3,'classification_absent':2,'generic_only':1,'conflicting':2,'product_identity_unmatched':1},counts
def assert_previous_equivalent(options):
 previous=dict(options)
 keys='source_platform,source_store,collaboration_name'+(',entry_product_ref' if 'MIN(entry_product_title) entry_product_title' in options['query'] else '')
 previous['query']=options['query'].replace('retention_with_medians AS (\n    SELECT *,PERCENTILE_CONT', 'retention_medians AS (\n    SELECT DISTINCT '+keys+',window_days,PERCENTILE_CONT').replace('FROM retention_with_medians GROUP BY', 'FROM retention_members JOIN retention_medians USING('+keys+',window_days) GROUP BY')
 assert previous['query'] != options['query']
 assert run(previous)==run(options), 'Previous and improved relational results differ'

assert_previous_equivalent(queries['retention'])
assert_previous_equivalent(queries['pieces'])
rows=run(queries['retention'])
a=next(r for r in rows if r['collaboration_name']=='alpha' and r['window_days']==90)
b=next(r for r in rows if r['collaboration_name']=='beta' and r['window_days']==180)
assert (a['cohort_customers'],a['mature_customers'],a['repeat_customers'],a['core_range'])==(2,1,1,1),a
assert (b['cohort_customers'],b['mature_customers'],b['repeat_customers'],b['different_collaboration'])==(1,1,1,1),b
assert next(r for r in rows if r['collaboration_name']=='beta' and r['window_days']==90)['repeat_customers']==0
print(json.dumps({'shared_joins':'passed','first_order_stages':counts,'retention':'alpha 90d: 1/1 mature; beta 90d: 0/1; beta 180d: 1/1','dialect':'BigQuery SQL translated to DuckDB; production acceptance outstanding'}))

c.execute('CREATE TABLE fixture.shopify_data.order_locations(order_id VARCHAR,retail_location_id VARCHAR,created_at TIMESTAMP,source_app_id VARCHAR)')
c.execute('CREATE TABLE fixture.shopify_data.order_customers(order_id VARCHAR,customer_id VARCHAR,display_financial_status VARCHAR,cancelled_at TIMESTAMP,is_guest BOOLEAN)')
c.execute('CREATE TABLE fixture.shopify_data.order_financials(order_id VARCHAR,presentment_currency VARCHAR,original_total_presentment DOUBLE,total_refunded_presentment DOUBLE)')
c.execute('CREATE TABLE fixture.shopify_data.order_line_items(order_id VARCHAR,product_id VARCHAR,title VARCHAR,name VARCHAR,quantity INT,discounted_total_presentment DOUBLE,presentment_currency VARCHAR)')
for order,customer,when,product,app in [('s1','gid://shopify/Customer/1','2025-11-16','gid://shopify/Product/100',None),('s2','gid://shopify/Customer/1','2025-12-16','101',None),('s3','gid://shopify/Customer/2','2025-11-16','102',None),('s4','gid://shopify/Customer/3','2025-11-16','gid://shopify/ProductVariant/100',None),('s5','gid://shopify/Customer/4','2025-11-16','100','gid://shopify/App/1758145')]:
 c.execute('INSERT INTO fixture.shopify_data.order_locations VALUES (?,NULL,?,?)',[order,when,app]);c.execute("INSERT INTO fixture.shopify_data.order_customers VALUES (?,?,'paid',NULL,FALSE)",[order,customer]);c.execute("INSERT INTO fixture.shopify_data.order_financials VALUES (?,'GBP',100,0)",[order]);c.execute("INSERT INTO fixture.shopify_data.order_line_items VALUES (?,?,'Synthetic option',NULL,1,100,'GBP')",[order,product])
# A cancelled older Shopify order must not move first-observed entry backwards.
c.execute("INSERT INTO fixture.shopify_data.order_locations VALUES ('cancelled',NULL,'2020-01-01',NULL)")
c.execute("INSERT INTO fixture.shopify_data.order_customers VALUES ('cancelled','gid://shopify/Customer/1','paid','2020-01-02',FALSE)")
c.execute("INSERT INTO fixture.shopify_data.order_financials VALUES ('cancelled','GBP',100,0)")
assert_previous_equivalent(queries['shopify'])
shop=run(queries['shopify'])
a=next(r for r in shop if r['collaboration_name']=='alpha' and r['window_days']==90)
assert (a['cohort_customers'],a['mature_customers'],a['repeat_customers'],a['different_collaboration'])==(1,1,1,1),a
print('Shopify numeric/GID joins, variant rejection, preserved 2025-11-16 first order, migration exclusion and retention: passed')

down=run(queries['downstream'])
assert len(down)==1 and down[0]['classification_status']=='governed_collaboration' and down[0]['product_returning_customers']==1,down
print('Shared downstream collaboration-name-only membership: passed')

c.execute("ALTER TABLE fixture.commerce.collection_classifications ADD COLUMN provenance VARCHAR DEFAULT 'human_governed'")
c.execute('CREATE TABLE fixture.shopify_catalogue.products(product_id VARCHAR)')
c.execute("INSERT INTO fixture.shopify_catalogue.products VALUES ('100'),('101'),('102')")
diag={key:run(options) for key,options in queries['diagnostics'].items()}
assert {r['source_product_ref'] for r in diag['gaps']}=={'woo:ww:0','woo:ww:3','woo:ww:5','woo:ww:6','woo:ww:8','woo:ww:99'},diag['gaps']
assert diag['identity'][0]['missing_customer_id']==1,diag['identity']
assert diag['first-orders'][0]['orders']==9
assert diag['subsequent'][0]['orders']==2
assert diag['members'][0]['members']==6
assert diag['aggregation'][0]['cohorts']==4
assert diag['full']==rows
assert diag['catalogue'][0]['historical_product_lines']==4 and diag['catalogue'][0]['missing_shopify_catalogue_lines']==1,diag['catalogue']
assert any(r['evidence_table']=='collection_classifications' and r['status']=='revoked' for r in diag['keys']),diag['keys']
print('All diagnostic SQL stages execute: gap identities, customer coverage, raw classification history and missing catalogue counts passed')

# Reconstruct the exact pre-optimisation dependencies, then execute both versions.
# This checks SQL results, rather than returning predetermined provider rows.
def baseline(options):
    import re
    old=dict(options)
    old['query']=re.sub(r", retention_next_orders AS \(.*?\n  \), retention_members AS \(", ", retention_members AS (", old['query'], flags=re.S)
    old['query']=old['query'].replace('LEFT JOIN retention_next_orders d ON', 'LEFT JOIN (SELECT * FROM downstream_orders QUALIFY ROW_NUMBER() OVER(PARTITION BY governed_customer_ref ORDER BY order_timestamp,order_ref)=1) d ON')
    old['query']=old['query'].replace('  entry_named_customers AS (SELECT governed_customer_ref,COUNTIF(collaboration_name IS NOT NULL)>0 named FROM entry_matches GROUP BY governed_customer_ref),\n', '')
    old['query']=old['query'].replace('COUNTIF(COALESCE(m.named,FALSE))>0 named,','COUNTIF(m.collaboration_name IS NOT NULL)>0 named,').replace('LEFT JOIN entry_named_customers m ON','LEFT JOIN entry_matches m ON')
    assert old['query'] != options['query']
    return old

# Add a first order containing multiple named pieces plus generic/unknown lines.
# Same customer belongs to alpha and beta; membership must remain overlapping.
for product in [2,6,99]:
 c.execute("INSERT INTO fixture.metorik_uk.order_line_items VALUES (1,?,900,'Extra piece',1,10,'GBP')",[product])
# An equal-timestamp order must not become the subsequent purchase.
c.execute("INSERT INTO fixture.metorik_uk.orders VALUES (13,1,'2025-01-01','completed','GBP',100,0)")
c.execute("INSERT INTO fixture.metorik_uk.order_line_items VALUES (13,99,900,'Tie',1,100,'GBP')")
# Same source IDs in another store must remain independent.
c.execute('CREATE SCHEMA fixture.metorik_us')
for table in ['orders','order_line_items']:
 c.execute(f'CREATE TABLE fixture.metorik_us.{table} AS SELECT * FROM fixture.metorik_uk.{table}')
c.execute("INSERT INTO fixture.commerce.product_classifications SELECT classification_id||'_usd',replace(subject_ref,'woo:ww:','woo:usd:'),classification_type,classification_value,provenance,status,effective_from,effective_to,supersedes_classification_id FROM fixture.commerce.product_classifications WHERE subject_ref LIKE 'woo:ww:%'")
c.execute("INSERT INTO fixture.commerce.product_classifications VALUES ('usd-alpha','woo:usd:1','collaboration_name','alpha','human_approved','active',NULL,NULL,NULL),('usd-beta','woo:usd:2','collaboration_name','beta','human_approved','active',NULL,NULL,NULL)")
for key in ['retention','pieces','usd','usdPieces','shopify','shopifyPieces','downstream']:
 options=queries[key]
 assert run(baseline(options))==run(options), f'Full baseline/result mismatch for {key}'
# Demonstrate reduced coverage intermediate cardinality, using the real CTEs.
def coverage_join_count(options,relation):
 probe=dict(options)
 probe['query']=options['query'].split(', retention_next_orders AS (')[0]+f' SELECT COUNT(*) n FROM entry_orders e LEFT JOIN classified_lines l USING(source_platform,source_store,order_ref) LEFT JOIN {relation} m ON m.governed_customer_ref=e.governed_customer_ref'
 return run(probe)[0]['n']
old_count=coverage_join_count(queries['retention'],'entry_matches')
new_count=coverage_join_count(queries['retention'],'entry_named_customers')
assert old_count>new_count,(old_count,new_count)
rows=run(queries['retention'])
a=next(r for r in rows if r['collaboration_name']=='alpha' and r['window_days']==90)
b=next(r for r in rows if r['collaboration_name']=='beta' and r['window_days']==90)
assert (a['cohort_customers'],a['mature_customers'],a['repeat_customers'],a['median_days_to_second'])==(2,1,1,30),a
assert (b['cohort_customers'],b['mature_customers'],b['repeat_customers'],b['median_days_to_second'])==(2,2,1,30),b
assert (a['core_range'],b['core_range'])==(1,1)
print(json.dumps({'complete_baseline_comparisons':7,'coverage_join_rows_before':old_count,'coverage_join_rows_after':new_count,'overlapping_cohorts_and_tied_timestamp':'passed','production_performance':'unverified'}))
# A conflicting second purchase must remain unknown, even if a later core order exists.
for order,when,product in [(20,'2025-01-01',1),(21,'2025-01-11',5),(22,'2025-01-21',4)]:
 c.execute("INSERT INTO fixture.metorik_uk.orders VALUES (?,10,?,'completed','GBP',100,0)",[order,when])
 c.execute("INSERT INTO fixture.metorik_uk.order_line_items VALUES (?,?,900,'Unknown repeat fixture',1,100,'GBP')",[order,product])
for key in ['retention','pieces']:
 assert run(baseline(queries[key]))==run(queries[key])
a=next(r for r in run(queries['retention']) if r['collaboration_name']=='alpha' and r['window_days']==90)
assert (a['cohort_customers'],a['mature_customers'],a['repeat_customers'],a['unknown'],a['median_days_to_second'])==(3,2,2,1,20),a
for overrides in [{'entry_product_ref':'absent'},{'entry_product_ref':'woo:ww:2'},{'subsequent_channel':'In-store'},{'entry_channel':'In-store'}]:
 options={**queries['retention'],'params':{**queries['retention']['params'],**overrides}}
 assert run(baseline(options))==run(options),overrides
print('Unknown first subsequent order, exact median, product filters, empty coverage and channel boundaries: passed')
# Count logical reachable dependencies, without claiming physical materialisation.
def expanded_references(options,target):
 from sqlglot import exp
 root=sqlglot.parse_one(options['query'],read='bigquery')
 ctes={cte.alias_or_name:cte.this for cte in root.args['with_'].expressions}
 root.set('with_',None)
 def count(node):
  total=0
  for table in node.find_all(exp.Table):
   if not table.db and table.name==target: total+=1
   if not table.db and table.name in ctes: total+=count(ctes[table.name])
  return total
 return count(root)
old_refs=expanded_references(baseline(queries['retention']),'entry_matches')
new_refs=expanded_references(queries['retention'],'entry_matches')
assert (old_refs,new_refs)==(3,2),(old_refs,new_refs)
print(json.dumps({'logical_entry_matches_dependencies_before':old_refs,'after':new_refs,'physical_materialisation':'not inferred'}))

# Execute real factory decomposition boundaries against the complete final fixture.
# Compare entire rows, including nested coverage, exact medians and truncation.
def assert_decomposed(key, overrides=None):
    plan=queries['plans'][key]
    options={**queries[key], 'params':{**queries[key]['params'],**(overrides or {})}}
    for stage in plan['stages']:
        translated=sqlglot.transpile(stage['query'].replace('_SESSION.', ''),read='bigquery',write='duckdb')[0]
        import re
        params={k:(v['value'] if isinstance(v,dict) and 'value' in v else v) for k,v in options['params'].items()}
        used=set(re.findall(r'\$([A-Za-z_][A-Za-z_0-9]*)',translated))
        c.execute('CREATE OR REPLACE TEMP TABLE cohort_'+stage['name']+' AS '+translated,{k:v for k,v in params.items() if k in used})
    decomposed=run({**options, 'query':plan['result'].replace('_SESSION.', '')})
    assert decomposed==run(options), ('Decomposition differs', key, overrides)
for key in queries['plans']:
    assert_decomposed(key)
    for overrides in [{'entry_product_ref':'absent'},{'subsequent_channel':'In-store'},{'entry_channel':'In-store'},{'cohort_limit':2,'limit':4},{'ranking_window':180,'retention_sort':'repeat_rate_desc'}]:
        assert_decomposed(key,overrides)
print('Complete decomposed rows equal monolithic rows for all six source/group routes, empty/filter/limit/ranking cases')
