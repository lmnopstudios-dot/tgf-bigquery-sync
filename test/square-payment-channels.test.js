import {squareChannelSqlFixture} from './helpers/square-channel-sql-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {squarePaymentChannelEvidenceSql,squareOrderChannelsSql} from '../oracle/square-channels.js';
import {cohortRelations} from '../oracle/cohort-execution.js';
import {customerJourneySql} from '../oracle/customer-journey.js';
const python=spawnSync('python3',['-c','import duckdb,sqlglot'],{timeout:10000}).status===0;
const payment=(oid,extra={})=>({order_id:oid,location_id:'STORE',status:'COMPLETED',source_type:'CARD',...extra});
const inputs=[
 ['flat',[payment('flat',{card_details_entry_method:'CONTACTLESS'})],'In-store','completed_card_present_at_order_location'],
 ['nested',[payment('nested',{card_details:{entry_method:'EMV'}})],'In-store','completed_card_present_at_order_location'],
 ['encoded',[payment('encoded',{card_details:JSON.stringify({entry_method:'SWIPED'})})],'In-store','completed_card_present_at_order_location'],
 ['agree',[payment('agree',{card_details_entry_method:' emv ',card_details:{entry_method:'EMV'}})],'In-store','completed_card_present_at_order_location'],
 ['blank_flat',[payment('blank_flat',{card_details_entry_method:' ',card_details:{entry_method:'EMV'}})],'In-store','completed_card_present_at_order_location'],
 ['conflict',[payment('conflict',{card_details_entry_method:'EMV',card_details:{entry_method:'KEYED'}})],'Unknown','conflicting_entry_method'],
 ['different_present',[payment('different_present',{card_details_entry_method:'EMV',card_details:{entry_method:'CONTACTLESS'}})],'Unknown','conflicting_entry_method'],
 ['cash',[payment('cash',{source_type:'CASH'})],'Unknown','noncard_or_mixed_completed_tender'],
 ['mixed',[payment('mixed',{card_details_entry_method:'EMV'}),payment('mixed',{source_type:'CASH'})],'Unknown','noncard_or_mixed_completed_tender'],
 ['pending',[payment('pending',{status:'PENDING',card_details_entry_method:'EMV'})],'Unknown','no_completed_payment'],
 ['failed',[payment('failed',{status:'FAILED',card_details_entry_method:'EMV'})],'Unknown','no_completed_payment'],
 ['ignore_pending',[payment('ignore_pending',{card_details_entry_method:'EMV'}),payment('ignore_pending',{status:'PENDING',location_id:'OTHER',source_type:'CASH'})],'In-store','completed_card_present_at_order_location'],
 ['ignore_failed',[payment('ignore_failed',{card_details_entry_method:'EMV'}),payment('ignore_failed',{status:'FAILED',card_details_entry_method:'KEYED',location_id:'OTHER'})],'In-store','completed_card_present_at_order_location'],
 ['missing_join',[],'Unknown','no_exact_payment_join'],
 ['wrong_join',[payment('wrong_join ',{card_details_entry_method:'EMV'})],'Unknown','no_exact_payment_join'],
 ['wrong_location',[payment('wrong_location',{card_details_entry_method:'EMV',location_id:'STORE '})],'Unknown','conflicting_payment_location'],
 ['two_locations',[payment('two_locations',{card_details_entry_method:'EMV'}),payment('two_locations',{card_details_entry_method:'EMV',location_id:'OTHER'})],'Unknown','conflicting_payment_location'],
 ['missing_location',[payment('missing_location',{card_details_entry_method:'EMV',location_id:null})],'Unknown','missing_payment_location'],
 ['missing_type',[payment('missing_type',{source_type:null,card_details_entry_method:'EMV'})],'Unknown','missing_payment_type'],
 ['missing_entry',[payment('missing_entry')],'Unknown','missing_entry_method'],
 ['malformed',[payment('malformed',{card_details:'{invalid'})],'Unknown','missing_entry_method'],
 ['keyed',[payment('keyed',{card_details_entry_method:'KEYED'})],'Unknown','nonpresent_or_unsupported_entry_method'],
 ['split_cards',[payment('split_cards',{card_details_entry_method:'EMV'}),payment('split_cards',{card_details:{entry_method:'CONTACTLESS'}})],'In-store','completed_card_present_at_order_location'],
 ['missing_order_location',[payment('missing_order_location',{card_details_entry_method:'EMV'})],'Unknown','missing_order_location']
];
test('shared report SQL uses the same warehouse-shape-aware resolver; legacy reports remain unchanged',()=>{
 const scope={version:'square_channels_v1',include_square:true,entry:'instore',followup:'all',next:'anywhere_then_filter'},identity={dataset:'identity',snapshot:'fixture',orderLinks:true};
 const r=cohortRelations(customerJourneySql('fixture','retention_windows',null,null,identity,true,scope,{state:'preview'}));
 assert.equal(r.relations.find(r=>r.name==='sx_channel_evidence').body,squarePaymentChannelEvidenceSql('fixture'));assert.equal(r.relations.find(r=>r.name==='sx_square_channels').body,squareOrderChannelsSql());assert.doesNotMatch(customerJourneySql('fixture','retention_windows',null,null,identity,true),/sx_channel_evidence/);
});
test('generated SQL executes flattened/nested, mixed-tender, status, exact-key and conflict cases',{skip:!python},()=>{
 const evidence=squarePaymentChannelEvidenceSql('fixture').replace('SELECT TO_JSON(p,stringify_wide_numbers=>TRUE) j FROM `fixture.square_data.payments` p','SELECT payload j FROM fixture_payments');
 const query=`WITH sx_square AS(SELECT * FROM fixture_orders),sx_channel_evidence AS(${evidence}),sx_square_channels AS(${squareOrderChannelsSql()}) SELECT * FROM sx_square_channels ORDER BY oid`;
 const fixture={query,orders:inputs.map(([id])=>[id,id==='missing_order_location'?null:'STORE']),payments:inputs.flatMap(([,p])=>p)};
 const r=spawnSync('python3',[new URL('./square-payment-channel-sql.py',import.meta.url).pathname],{input:JSON.stringify(fixture),encoding:'utf8',timeout:30000});assert.equal(r.status,0,r.stderr);
 const rows=JSON.parse(r.stdout);assert.equal(rows.length,inputs.length);
 for(const [id,,channel,reason]of inputs){const row=rows.find(r=>r.oid===id);assert.equal(row.channel,channel,id);assert.equal(row.channel_reason,reason,id);}
 assert.equal(rows.find(r=>r.oid==='ignore_pending').ignored_noncompleted_payments,1);assert.equal(rows.find(r=>r.oid==='split_cards').completed_payments,2);
});

test('full generated customer-report path returns identical cohorts with flattened, nested or encoded payments',{skip:!python},()=>{
 const scope={version:'square_channels_v1',include_square:true,entry:'instore',followup:'all',next:'anywhere_then_filter'};let baseline;
 for(const paymentShape of ['nested','flat','encoded']){const fixture=squareChannelSqlFixture(scope,{paymentShape});const r=spawnSync('python3',[new URL('./square-channel-sql.py',import.meta.url).pathname],{input:JSON.stringify(fixture),encoding:'utf8',timeout:30000,maxBuffer:5000000});assert.equal(r.status,0,r.stderr);const result=JSON.parse(r.stdout);assert.ok(result[0].reporting_coverage.some(c=>c.source_platform==='square'&&c.channel==='In-store'&&c.eligible_orders>0));if(baseline)assert.deepEqual(result,baseline);else baseline=result;}
});
