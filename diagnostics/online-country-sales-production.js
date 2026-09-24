import { pathToFileURL } from 'node:url';
import { BigQuery } from '@google-cloud/bigquery';
import { createOnlineCountrySalesService, MATRIXIFY_APP_ID, onlineCountrySalesSql } from '../oracle/online-country-sales.js';

const READ_ONLY = /^\s*(?:WITH|SELECT)\b/i;
const WRITES = /\b(?:INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE|EXPORT)\b/i;

export function reconciliationSql(project) {
  const aggregate = onlineCountrySalesSql(project).replace(/ORDER BY currency,country_rank LIMIT 100\s*$/, '');
  return `WITH result AS (${aggregate})
    SELECT currency,
      ANY_VALUE(eligible_orders) eligible_orders,
      SUM(IF(country_rank=1,ARRAY_LENGTH(source_coverage),0)) source_coverage_rows,
      MAX(country_rank) maximum_rank,
      COUNTIF(country_code IS NOT NULL) returned_countries,
      COUNT(DISTINCT CONCAT(currency,':',country_code)) distinct_country_rows,
      ANY_VALUE(eligible_sales) eligible_sales,
      ANY_VALUE(unknown_country_orders) unknown_country_orders,
      ANY_VALUE(unknown_country_sales) unknown_country_sales
    FROM result GROUP BY currency ORDER BY currency`;
}

export async function validateOnlineCountrySales({ bigquery, project='gf-full-data', input }) {
  const service=createOnlineCountrySalesService({bigquery,project});
  const result=await service(input);
  const sql=reconciliationSql(project);
  if(!READ_ONLY.test(sql)||WRITES.test(sql)) throw new Error('validator SQL is not read-only');
  const [reconciliation]=await bigquery.query({query:sql,params:{...input,matrixify_app_id:MATRIXIFY_APP_ID},types:{currency:'STRING'},useLegacySql:false,maximumBytesBilled:'10000000000',labels:{component:'validator',operation:'online_country_reconciliation'}});
  const failures=[];
  if(result.rows.length>100)failures.push('aggregate output exceeds 100 rows');
  if(result.rows.some(row=>Number(row.country_rank)>10))failures.push('country rank exceeds 10');
  for(const row of reconciliation){
    if(Number(row.returned_countries)!==Number(row.distinct_country_rows))failures.push(`${row.currency} duplicate country join detected`);
    if(Number(row.source_coverage_rows)<1)failures.push(`${row.currency} has no source coverage`);
    if(Number(row.unknown_country_orders)>Number(row.eligible_orders))failures.push(`${row.currency} unknown orders exceed eligible orders`);
  }
  if(failures.length)throw new Error(`Online country sales production validation failed: ${failures.join('; ')}`);
  return {status:'passed',contract:result.contract,period:result.period,returned_rows:result.rows.length,reconciliation};
}

function parse(argv){const value=n=>argv.find(x=>x.startsWith(`--${n}=`))?.split('=').slice(1).join('=')||null;return{start_date:value('start')||'2022-09-24',end_date:value('end')||'2026-09-24',currency:value('currency')}}
async function main(){const credentials=JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON||'null');if(!credentials)throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON');const project=process.env.GOOGLE_PROJECT_ID||'gf-full-data';console.log(JSON.stringify(await validateOnlineCountrySales({bigquery:new BigQuery({projectId:project,credentials}),project,input:parse(process.argv.slice(2))}),null,2))}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(error.message);process.exitCode=1});
