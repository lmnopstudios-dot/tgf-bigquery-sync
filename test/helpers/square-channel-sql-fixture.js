import {createHash} from 'node:crypto';
import {customerJourneySql} from '../../oracle/customer-journey.js';
import {cohortRelations} from '../../oracle/cohort-execution.js';
const literal=(x,t='STRING')=>x==null?`CAST(NULL AS ${t})`:t==='BOOL'?(x?'TRUE':'FALSE'):['INT64','NUMERIC'].includes(t)?String(x):`CAST('${String(x).replaceAll("'","''")}' AS ${t})`;
const table=(cols,rows)=>rows.length?rows.map(row=>'SELECT '+cols.map(([k,t],i)=>`${literal(row[i],t)} ${k}`).join(',')).join(' UNION ALL '):'SELECT '+cols.map(([k,t])=>`CAST(NULL AS ${t}) ${k}`).join(',')+' WHERE FALSE';
const reference=x=>'c_'+createHash('sha256').update('email-record|'+x.toLowerCase()).digest('hex');
export function squareChannelSqlFixture(scope,{group='retention_product_journeys',terminal=null,missingPersistedFor=[],emptyPayloadFor=[]}={}){
 const identity={dataset:'identity',snapshot:'fixture',mode:'email_candidate_v2',orderLinks:true};
 const parsed=cohortRelations(customerJourneySql('fixture',group,null,null,identity,true,scope,{state:'preview'}));
 const by=new Map(parsed.relations.map(r=>[r.name,r]));
 const refs=Object.fromEntries(['A','B','C','D','E','T'].map(k=>[k,reference(k.toLowerCase()+'@real.org')]));
 const sq=[],pay=[],items=[];
 const addSq=(oid,cid,day,product='P1',present=true)=>{
  const line={uid:oid+'line',item_id:product,quantity:'1',name:product==='UNM'?'Alpha collaboration ring (unclassified title)':'Approved label'};
  sq.push([oid,cid,'STORE',day,day,'COMPLETED',JSON.stringify([line]),'GBP']);
  pay.push([oid,cid,'STORE','COMPLETED','CARD',present?'EMV':'KEYED']);
  items.push([oid,0,line.uid,product,1,JSON.stringify(line)]);
 };
 addSq('qa','A','2024-01-01T12:00:00Z');addSq('qa2','A','2024-01-10T12:00:00Z');
 addSq('qb','B','2024-01-02T12:00:00Z');addSq('qc','C','2024-01-05T12:00:00Z');
 addSq('qu','U','2024-01-01T12:00:00Z','UNM');addSq('qu2','U','2024-01-03T12:00:00Z','UNM');
 addSq('qd','D','2024-01-01T12:00:00Z','P1',false);
 addSq('qg',null,'2024-01-01T12:00:00Z','UNM');addSq('qg2',null,'2024-01-03T12:00:00Z','UNM');
 addSq('qe','E','2024-01-01T12:00:00Z');addSq('qe2','E','2024-01-03T12:00:00Z');
 addSq('qt','T','2024-01-01T12:00:00Z');addSq('qt2','T','2024-01-02T12:00:00Z');
 addSq('qamb','AMB','2024-01-01T12:00:00Z','AMB');
 for(const row of sq)if(emptyPayloadFor.includes(row[0]))row[6]='[]';
 const woo=[['wa',101,'2024-01-05T12:00:00Z','completed','GBP',100,0],['wb',102,'2023-12-01T12:00:00Z','completed','GBP',100,0],['wc',103,'2024-01-01T12:00:00Z','completed','GBP',100,0],['wd',104,'2024-01-02T12:00:00Z','completed','GBP',100,0],['we',105,'2024-01-04T12:00:00Z','completed','GBP',100,0],['wt',106,'2024-01-01T12:00:00Z','completed','GBP',100,0]];
 const shops=[['sa','SA','2024-01-15T12:00:00Z','Point of Sale','POS',null],['sb','SB','2024-01-03T12:00:00Z','Point of Sale','POS',null],['sc','SC','2024-01-03T12:00:00Z','Online Store',null,null],['import','SB','2022-01-01T12:00:00Z','Matrixify',null,'gid://shopify/App/1758145']];
 const snapshot=[...woo.map((r,i)=>['ww',r[0],String(r[1]),refs[['A','B','C','D','E','T'][i]],'matched','completed',false]),...shops.map(r=>['shopify',r[0],r[1],refs[r[1].slice(1)],'matched','paid',false])];
 const mappingCols=[['source_store','STRING'],['source_order_id','STRING'],['source_customer_id','STRING'],['canonical_customer_ref','STRING'],['resolution','STRING'],['financial_status','STRING'],['cancelled','BOOL']];
 by.get('ci_mapping').body=table(mappingCols,snapshot);
 by.get('sx_snapshot').body=`SELECT source_store source,source_order_id oid,source_customer_id cid,canonical_customer_ref canonical,resolution,FALSE conflicting_email,FALSE shared_email,financial_status,cancelled FROM ci_mapping`;
 by.get('sx_guard').body='SELECT TRUE passed';
 // sx_snapshot appears ahead of ci_mapping in the real source plan; the fixture
 // input is placed first, without changing any identity/transaction expressions.
 const sourceTables={
 square_orders:table([['id','STRING'],['customer_id','STRING'],['location_id','STRING'],['created_at','STRING'],['updated_at','STRING'],['state','STRING'],['line_items','STRING'],['currency','STRING']],[...sq,sq[0]]),
 square_payments:pay.map(r=>'SELECT '+r.slice(0,5).map((v,i)=>literal(v)+' '+['order_id','customer_id','location_id','status','source_type'][i]).join(',')+`,STRUCT(${literal(r[5])} AS entry_method) card_details`).join(' UNION ALL '),
 square_items:table([['order_id','STRING'],['source_line_offset','INT64'],['line_item_uid','STRING'],['catalog_object_id','STRING'],['quantity','NUMERIC'],['transaction_line_item_json','STRING']],[...items.filter(r=>!missingPersistedFor.includes(r[0])),items[0]]),
 directory:table([['id','STRING'],['email_address','STRING']],['A','B','C','D','E','E2','T'].map(k=>[k,(k==='E2'?'e':k.toLowerCase())+'@real.org'])),
 ww:table([['order_id','STRING'],['customer_id','INT64'],['order_created_at','TIMESTAMP'],['status','STRING'],['currency','STRING'],['total','NUMERIC'],['total_refunds','NUMERIC']],[...woo,woo[0]]),
 usd:table([['order_id','STRING'],['customer_id','INT64'],['order_created_at','TIMESTAMP'],['status','STRING'],['currency','STRING'],['total','NUMERIC'],['total_refunds','NUMERIC']],[]),
 locations:table([['order_id','STRING'],['created_at','TIMESTAMP'],['order_source','STRING'],['retail_location_id','STRING'],['source_app_id','STRING']],shops.map(r=>[r[0],r[2],r[3],r[4],r[5]])),
 customers:table([['order_id','STRING'],['customer_id','STRING'],['display_financial_status','STRING'],['cancelled_at','TIMESTAMP'],['is_guest','BOOL']],shops.map(r=>[r[0],r[1],'PAID',null,false])),
 financials:table([['order_id','STRING'],['presentment_currency','STRING'],['original_total_presentment','NUMERIC'],['total_refunded_presentment','NUMERIC']],shops.map(r=>[r[0],'GBP',100,0])),
 woo_lines:table([['order_id','STRING'],['product_id','STRING'],['name','STRING'],['quantity','NUMERIC'],['total','NUMERIC'],['currency','STRING']],woo.map(r=>[r[0],'1','Reviewed Woo product',1,100,'GBP'])),
 usd_lines:table([['order_id','STRING'],['product_id','STRING'],['name','STRING'],['quantity','NUMERIC'],['total','NUMERIC'],['currency','STRING']],[]),
 shop_lines:table([['order_id','STRING'],['product_id','STRING'],['title','STRING'],['name','STRING'],['quantity','NUMERIC'],['discounted_total_presentment','NUMERIC'],['presentment_currency','STRING']],shops.map(r=>[r[0],'10','Reviewed Shopify product',null,1,100,'GBP'])),
 collections:table([['collection_id','STRING'],['title','STRING'],['product_count','INT64']],[]),product_collections:table([['collection_id','STRING'],['product_id','STRING']],[])
 };
 const paths={'square_data.orders':'square_orders','square_data.payments':'square_payments','square_data.retail_order_items':'square_items','customers.square_data':'directory','metorik_uk.orders':'ww','metorik_us.orders':'usd','metorik_uk.order_line_items':'woo_lines','metorik_us.order_line_items':'usd_lines','shopify_data.order_locations':'locations','shopify_data.order_customers':'customers','shopify_data.order_financials':'financials','shopify_data.order_line_items':'shop_lines','shopify_catalogue.collections':'collections','shopify_catalogue.product_collections':'product_collections'};
 const fixtures={cr_resolved:table([['subject_ref','STRING'],['classification_type','STRING'],['classification_value','STRING']],['square:square:P1','woo:ww:1','shopify:shopify:10','square:square:AMB'].flatMap(r=>[[r,'collaboration_name','alpha'],[r,'product_group','collaboration']])),
 cr_conflicts:table([['subject_ref','STRING']],[]),
 cr_routes:table([['source_ref','STRING'],['classification_ref','STRING'],['mapping_type','STRING']],[['square:square:P1','shopify:shopify:10','approved_reporting_family'],['woo:ww:1','shopify:shopify:10','approved_reporting_family'],['square:square:AMB','shopify:shopify:10','approved_reporting_family'],['square:square:AMB','shopify:shopify:11','approved_reporting_family']]),
 cr_identity:table([['source_ref','STRING'],['classification_ref','STRING']],[]),
 cr_family:table([['source_ref','STRING'],['classification_ref','STRING']],[['square:square:P1','shopify:shopify:10'],['woo:ww:1','shopify:shopify:10']]),
 cr_family_current:table([['shopify_parent_ref','STRING'],['shopify_parent_title','STRING'],['status','STRING']],[['shopify:shopify:10','Reviewed family','active']]),
 cr_collection_current:table([['collection_id','STRING'],['collection_title','STRING'],['classification_type','STRING'],['classification_value','STRING'],['status','STRING']],[])};
 for(const [name,body]of Object.entries(fixtures))by.get(name).body=body;
 let result=terminal||parsed.result;
 const needed=new Set();const visit=body=>{for(const m of body.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][a-z_0-9]*)\b/gi))if(by.has(m[1])&&!needed.has(m[1])){needed.add(m[1]);visit(by.get(m[1]).body);}};visit(result);
 let query='WITH '+[...Object.entries(sourceTables).map(([name,body])=>`f_${name} AS (${body})`),`ci_mapping AS (${by.get('ci_mapping').body})`,...parsed.relations.filter(r=>r.name!=='ci_mapping'&&needed.has(r.name)).map(r=>`${r.name} AS (${r.body})`)].join(',\n')+'\n'+result;
 for(const [path,name]of Object.entries(paths))query=query.replaceAll('`fixture.'+path+'`','f_'+name);
 query=query.replaceAll(',stringify_wide_numbers=>TRUE','');
 if(/`fixture\./.test(query))throw Error('Fixture unexpectedly reads warehouse table');
 const params={time_zone:'UTC',cohort_entry_start:'2024-01-01',cohort_entry_end:'2024-01-02',observation_end:'2026-10-19',start_date:'2024-01-01',end_date:'2024-01-02',first_order_semantic:'first_observed_ever',entry_source:null,entry_channel:scope.entry==='all'?null:scope.entry==='online'?'Online':'In-store',minimum_sequence:2,maximum_sequence:null,within_days:null,subsequent_source:null,subsequent_channel:scope.followup==='all'?null:scope.followup==='online'?'Online':'In-store',coverage_status:'unverified',coverage_start:null,coverage_end:null,coverage_evidence:null,entry_classification:group==='retention_product_journeys'?null:'collaboration',entry_product_ref:null,retention_source_store:null,ranking_window:90,retention_sort:'repeat_rate_desc',cohort_limit:33,limit:99,retention_store_count:1,matrixify_app_id:'gid://shopify/App/1758145',subsequent_product_ref:null,subsequent_classification:null,include_unclassified:false,excluded_product_titles:[]};
 return {query,params};
}
