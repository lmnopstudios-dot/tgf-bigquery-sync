import assert from 'node:assert/strict';
import {datesBetween} from '../../ga4/semantic.js';
import {createKpiConversionReader} from '../../oracle/kpi-conversion.js';
import {KPI_NOW} from './kpi-fixture.js';
export function conversionFixture({missingDay=null,failGroup=null,zero=false,timezone='Europe/London',grants=true,now=KPI_NOW,failCode='ACCESS_DENIED'}={}){
 const calls=[];
 const graphql=async(query,variables)=>{
  calls.push({query,variables});
  if(!variables?.query)return {shop:{id:'gid://shopify/Shop/42',ianaTimezone:timezone},currentAppInstallation:{accessScopes:grants?[{handle:'read_reports'}]:[]}};
  const sql=variables.query,[,start,end]=sql.match(/SINCE (\S+) UNTIL (\S+)/),uk=sql.includes("session_country_code = 'GB'"),intl=sql.includes("session_country_code != 'GB'"),group=uk?'uk':intl?'international':'combined';
  assert.match(sql,/human_or_bot_session = 'human'/);assert.match(sql,/sessions_that_completed_checkout/);
  if(intl){assert.match(sql,/IS NOT NULL/);assert.match(sql,/!= ''/);assert.match(sql,/!= 'ZZ'/);}
  if(group===failGroup)throw Object.assign(Error('private synthetic source error'),{code:failCode});
  const names=['day',...(uk?['session_country_code']:[]),'sessions','sessions_that_completed_checkout'];
  const rows=datesBetween(start,end).filter(day=>!(day===missingDay&&uk)).map(day=>{
   const n=Number(day.slice(-2)),sessions=zero?0:uk?(n%2?100:900):intl?500:(n%2?100:900)+550,numerator=zero?0:uk?(n%2?10:9):intl?5:(n%2?10:9)+6;
   return {day,...(uk?{session_country_code:'GB'}:{}),sessions,sessions_that_completed_checkout:numerator};
  });
  return {shopifyqlQuery:{parseErrors:[],tableData:{columns:names.map(name=>({name})),rows}}};
 };
 return {calls,read:createKpiConversionReader({graphql,now:()=>new Date(now)})};
}
