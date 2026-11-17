import {performanceOrderSources,observationCovered,commerceCertificates} from './loyalty-performance.js';
import {loadLoyaltyConfig} from '../loyaltylion/runtime-config.js';
import {boundedQuery} from './bounded-query.js';
import {londonDay} from '../public/oracle/kpi-intent.js';
import {datasetLocation} from '../bigquery/dataset-location.js';
// Existing order authority, extended only with aggregate diagnostics and explicit windows.
const kpiOrderSources=project=>performanceOrderSources(project).replace('c.customer_id source_customer_id',()=>"CASE WHEN REGEXP_CONTAINS(c.customer_id,r'^gid://shopify/Customer/[0-9]+$') THEN c.customer_id ELSE NULL END source_customer_id").replace('AND created_at<TIMESTAMP(@as_of)',()=>"AND REGEXP_CONTAINS(source_order_id,r'^gid://shopify/Order/[0-9]+$') AND created_at<TIMESTAMP(@as_of)");
export function kpiCommerceSql(project){
 const sources=kpiOrderSources(project);
 // Retain customerless qualifying orders for order AOV, but never customer denominators.
 const orders=sources.replace("source_customer_id IS NOT NULL AND source_customer_id NOT IN ('', '0') AND ",'');
 return `WITH ${orders},windows AS(SELECT JSON_VALUE(w,'$.id') period,DATE(JSON_VALUE(w,'$.start_date')) start_date,DATE(JSON_VALUE(w,'$.end_date')) end_date FROM UNNEST(JSON_QUERY_ARRAY(@windows)) w),
 selected AS(SELECT o.* FROM qualifying_orders o WHERE (@channel='combined' OR channel=@channel) AND (@currency IS NULL OR currency=@currency)),
 historical AS(SELECT source_customer_id,MIN(created_at) first_at FROM qualifying_orders WHERE source_customer_id IS NOT NULL AND source_customer_id NOT IN ('','0') GROUP BY 1),
 ordered AS(SELECT *,LAG(created_at) OVER(PARTITION BY source_customer_id,currency ORDER BY created_at,source_order_id) previous_at FROM selected WHERE source_customer_id IS NOT NULL AND source_customer_id NOT IN ('','0')),
 gaps AS(SELECT w.period,o.currency,o.source_customer_id,o.previous_at,TIMESTAMP_DIFF(o.created_at,o.previous_at,SECOND)/86400.0 gap FROM ordered o JOIN windows w ON DATE(o.created_at,'Europe/London') BETWEEN w.start_date AND w.end_date WHERE previous_at IS NOT NULL),
 gap_medians AS(SELECT *,PERCENTILE_CONT(gap,0.5) OVER(PARTITION BY period,currency) median_gap FROM gaps),
 gap_totals AS(SELECT period,currency,AVG(gap) mean_gap,MAX(median_gap) median_gap,COUNT(*) intervals,COUNT(DISTINCT source_customer_id) interval_customers,MIN(CAST(DATE(previous_at,'Europe/London') AS STRING)) required_gap_start FROM gap_medians GROUP BY 1,2),
 totals AS(SELECT w.period,o.currency,COUNT(*) orders,COUNTIF(o.gross IS NULL) missing_values,CAST(SUM(o.gross) AS STRING) gross,
 COUNTIF(o.source_customer_id IS NULL OR o.source_customer_id IN ('','0')) customerless_orders,
 COUNT(DISTINCT IF(o.source_customer_id NOT IN ('','0'),o.source_customer_id,NULL)) customers,
 COUNT(DISTINCT IF(DATE(h.first_at,'Europe/London')<w.start_date,o.source_customer_id,NULL)) observed_returning_customers,
 COUNT(DISTINCT IF(DATE(h.first_at,'Europe/London')>=w.start_date,o.source_customer_id,NULL)) first_observed_customers
 FROM selected o JOIN windows w ON DATE(o.created_at,'Europe/London') BETWEEN w.start_date AND w.end_date LEFT JOIN historical h USING(source_customer_id) GROUP BY 1,2)
 SELECT t.*,g.* EXCEPT(period,currency),CAST((SELECT MAX(synced_at) FROM f) AS STRING) finance_observed_at,CAST((SELECT MAX(synced_at) FROM c) AS STRING) customer_observed_at,CAST((SELECT MAX(synced_at) FROM l) AS STRING) channel_observed_at FROM totals t LEFT JOIN gap_totals g USING(period,currency) ORDER BY 1,2 LIMIT 1001`;
}
export function kpiRetentionSql(project){
 return `WITH ${kpiOrderSources(project)},windows AS(SELECT JSON_VALUE(w,'$.id') period,DATE(JSON_VALUE(w,'$.start_date')) start_date,DATE(JSON_VALUE(w,'$.end_date')) end_date FROM UNNEST(JSON_QUERY_ARRAY(@windows)) w),
 selected AS(SELECT * FROM qualifying_orders WHERE (@channel='combined' OR channel=@channel) AND (@currency IS NULL OR currency=@currency)),
 indexes AS(SELECT w.period,o.currency,o.source_customer_id,o.created_at index_at,o.source_order_id index_id FROM selected o JOIN windows w ON DATE(o.created_at,'Europe/London') BETWEEN w.start_date AND w.end_date QUALIFY ROW_NUMBER() OVER(PARTITION BY w.period,o.currency,o.source_customer_id ORDER BY o.created_at,o.source_order_id)=1),
 nexts AS(SELECT i.*,MIN(o.created_at) next_at FROM indexes i LEFT JOIN selected o ON o.source_customer_id=i.source_customer_id AND o.currency=i.currency AND (o.created_at>i.index_at OR (o.created_at=i.index_at AND o.source_order_id>i.index_id)) GROUP BY 1,2,3,4,5)
 SELECT period,currency,horizon,COUNT(*) cohort_customers,MIN(IF(TIMESTAMP_DIFF(TIMESTAMP(@as_of),index_at,SECOND)>=horizon*86400,UNIX_SECONDS(index_at),NULL)) mature_start_epoch,MAX(IF(TIMESTAMP_DIFF(TIMESTAMP(@as_of),index_at,SECOND)>=horizon*86400,UNIX_SECONDS(index_at)+horizon*86400,NULL)) mature_end_epoch,COUNTIF(TIMESTAMP_DIFF(TIMESTAMP(@as_of),index_at,SECOND)>=horizon*86400) mature_customers,
 COUNTIF(TIMESTAMP_DIFF(TIMESTAMP(@as_of),index_at,SECOND)>=horizon*86400 AND TIMESTAMP_DIFF(next_at,index_at,SECOND)<=horizon*86400) returned_customers FROM nexts CROSS JOIN UNNEST([30,60,90]) horizon GROUP BY 1,2,3 ORDER BY 1,2,3 LIMIT 3001`;
}
export function reviewedKpiCoverage(env=process.env){
 try{return commerceCertificates(loadLoyaltyConfig(env));}catch{return [];}
}
export function kpiInstantCovered(intervals,start,end,channel){return (channel==='combined'?['online','instore','unknown']:[channel]).every(ch=>observationCovered(intervals,start,end,ch));}
export function kpiCovered(intervals,p,channel){
 // Convert London dates to UTC instants (including DST) without relying on host TZ.
 const instant=day=>{const probe=Date.parse(day+'T00:00:00Z'),parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',timeZoneName:'shortOffset'}).formatToParts(probe),offset=parts.find(p=>p.type==='timeZoneName').value==='GMT+1'?3600000:0;return new Date(Date.parse(day+'T00:00:00Z')-offset).toISOString();};
 const next=new Date(Date.parse(p.end_date+'T00:00:00Z')+86400000).toISOString().slice(0,10);
 return kpiInstantCovered(intervals,instant(p.start_date),instant(next),channel);
}
export function createKpiReader({bigquery,project}){
 return async({periods,scope,now,signal,deadlineAt,onProviderStage})=>{
  if(scope.geography!=='all')throw Object.assign(Error('Shipping geography coverage unavailable'),{code:'KPI_GEOGRAPHY_UNAVAILABLE'});
  const location=await datasetLocation(bigquery,project,'shopify_data');
  const params={windows:JSON.stringify(periods),channel:scope.channel,currency:scope.currency,as_of:londonDay(now)+'T00:00:00'+(new Intl.DateTimeFormat('en',{timeZone:'Europe/London',timeZoneName:'shortOffset'}).formatToParts(new Date(londonDay(now)+'T00:00:00Z')).find(p=>p.type==='timeZoneName').value==='GMT+1'?'+01:00':'Z'),matrixify_app_id:'gid://shopify/App/1758145'};
  const types={windows:'STRING',channel:'STRING',currency:'STRING',as_of:'STRING',matrixify_app_id:'STRING'};
  const settled=await Promise.allSettled([['commerce',kpiCommerceSql(project),1000],['retention',kpiRetentionSql(project),3000]].map(async([name,query,bound])=>{
   const [rows]=await boundedQuery(bigquery,{query,params,types,location,useLegacySql:false,maximumBytesBilled:'1000000000',labels:{component:'oracle_kpi',operation:name}},{signal,deadlineAt,maximumMs:45000,onProviderStage});
   if(rows.length>bound)throw Object.assign(Error('KPI row bound'),{code:'KPI_ROW_BOUND'});return rows;
  }));
  return Object.fromEntries(settled.map((r,i)=>[i?'retention':'commerce',r.status==='fulfilled'?{rows:r.value}:{rows:[],failure:safeKpiFailure(r.reason)}]));
 };
}
export function safeKpiFailure(e){const c=e?.code,r=e?.errors?.[0]?.reason;return ['KPI_GEOGRAPHY_UNAVAILABLE','KPI_ROW_BOUND','REQUEST_CANCELLED','ORACLE_AGENT_DEADLINE'].includes(c)?c:['accessDenied','notFound','invalidQuery','quotaExceeded','rateLimitExceeded'].includes(r)?r:'KPI_SOURCE_UNAVAILABLE';}
