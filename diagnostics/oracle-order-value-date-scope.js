/** Read-only aggregate date probes. No collectors, customer rows or financial measures. */
import { BigQuery } from '@google-cloud/bigquery';
import { pathToFileURL } from 'node:url';
import { validateOrderValueDiagnostic } from './oracle-order-values.js';
import { orderValuePopulationSql, orderValueQueryOptions } from '../oracle/order-value-provider.js';
import { createOracleProviderDependencies } from '../oracle/provider-dependencies.js';
import { datasetLocation } from '../bigquery/dataset-location.js';
import { boundedEvidenceRead } from '../oracle/bounded-evidence-read.js';
import { safeReadFailure } from '../oracle/read-failure.js';

export function orderValueDateScopeSql(project,input) {
  validateOrderValueDiagnostic(input); // Literal interpolation accepts only real ISO dates.
  const components=[['locations','order_locations','created_at'],['financials','order_financials','created_at'],['customers','order_customers','order_created_at'],['geography','order_shipping_geography','order_created_at']];
  const metric=(alias,table,field,snapshot)=>{
    const counts=['UTC','Europe/London'].flatMap(zone=>{
      const date=zone==='UTC'?`DATE(${field})`:`DATE(${field},'${zone}')`,prefix=zone==='UTC'?'utc':'london';
      return [
        `COUNT(DISTINCT IF(${date} BETWEEN DATE '${input.start}' AND DATE '${input.end}',order_id,NULL)) ${prefix}_literal_orders`,
        `COUNT(DISTINCT IF(${date} BETWEEN DATE(@start_date) AND DATE(@end_date),order_id,NULL)) ${prefix}_bound_orders`,
        `COUNT(DISTINCT IF(${date} BETWEEN @date_start_control AND @date_end_control,order_id,NULL)) ${prefix}_typed_date_orders`
      ];
    });
    return `SELECT '${table}' component,'${snapshot}' snapshot,
      CAST(@start_date AS STRING) bound_start_date,CAST(@end_date AS STRING) bound_end_date,
      TYPEOF(@start_date) start_parameter_type,TYPEOF(@end_date) end_parameter_type,
      CAST(@date_start_control AS STRING) date_control_start,CAST(@date_end_control AS STRING) date_control_end,
      TYPEOF(@date_start_control) date_control_type,
      ${counts.join(',\n      ')},
      (SELECT COUNT(*) FROM scoped) shared_production_date_scope_orders
    FROM ${alias}`;
  };
  return `${orderValuePopulationSql(project)}\n${components.flatMap(([alias,table,field])=>[
    metric(`\`${project}.shopify_data.${table}\``,table,field,'raw'),metric(alias,table,field,'latest')
  ]).join('\nUNION ALL\n')}`;
}
export async function diagnoseOrderValueDateScope(input,{bigquery,project}) {
  validateOrderValueDiagnostic(input);
  const location=await boundedEvidenceRead(()=>datasetLocation(bigquery,project,'shopify_data'),{maximumMs:30000});
  const options={...orderValueQueryOptions({start_date:input.start,end_date:input.end,country:'GB',currency:'GBP',basis:'observed_subtotal'},location),jobTimeoutMs:30000};
  options.params={...options.params,date_start_control:BigQuery.date(input.start),date_end_control:BigQuery.date(input.end)};
  options.types={...options.types,date_start_control:'DATE',date_end_control:'DATE'};
  const sdk=new BigQuery({projectId:project});
  const wire=sdk.buildQueryParams_(options.params,options.types).params.filter(p=>['start_date','end_date','date_start_control','date_end_control'].includes(p.name));
  const query=orderValueDateScopeSql(project,input);
  await boundedEvidenceRead(()=>bigquery.createQueryJob({...options,query,dryRun:true}),{maximumMs:30000});
  const [rows]=await boundedEvidenceRead(()=>bigquery.query({...options,query}),{maximumMs:30000});
  if(rows.length!==8)throw Error('Expected eight bounded component aggregates');
  const reconcile=rows.every(r=>['utc','london'].every(zone=>Number(r[zone+'_literal_orders'])===Number(r[zone+'_bound_orders'])&&Number(r[zone+'_bound_orders'])===Number(r[zone+'_typed_date_orders']))&&r.bound_start_date===input.start&&r.bound_end_date===input.end&&r.date_control_start===input.start&&r.date_control_end===input.end&&r.start_parameter_type==='STRING'&&r.end_parameter_type==='STRING'&&r.date_control_type==='DATE');
  const locationRow=rows.find(r=>r.component==='order_locations'&&r.snapshot==='latest');
  const productionReconciled=!!locationRow&&rows.every(r=>Number(r.shared_production_date_scope_orders)===Number(locationRow.london_bound_orders));
  return {read_only:true,aggregate_only:true,period:{start_date:input.start,end_date:input.end},location,
    bounds:{maximum_queries:2,maximum_rows:8,maximum_bytes_per_query:1000000000,timeout_ms:30000},wire_date_parameters:wire,
    predicates:{production:"order_date BETWEEN DATE(@start_date) AND DATE(@end_date); order_date = DATE(l.created_at,'Europe/London')",literal:`DATE(timestamp, zone) BETWEEN DATE '${input.start}' AND DATE '${input.end}'`,typed_date:'DATE(timestamp, zone) BETWEEN @date_start_control AND @date_end_control',shopify_sales_report:'onlineCountrySalesSql: DATE(f.created_at) order_date; order_date BETWEEN DATE(@start_date) AND DATE(@end_date); dates inferred STRING'},
    components:rows,date_counts_reconciled:reconcile,production_date_scope_reconciled:productionReconciled,
    shopify_sales_date_predicate_counts:rows.filter(r=>r.component==='order_financials').map(r=>({snapshot:r.snapshot,utc_orders:r.utc_bound_orders,london_orders:r.london_bound_orders})),
    interpretation:'Financial UTC counts reproduce the working sales date predicate before its eligibility filters. London differences are expected at midnight boundaries. Count reconciliation does not establish collection completeness or equivalent sales populations.'};
}
async function main(){
  const input={};for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i];if(!key?.startsWith('--')||!process.argv[i+1])throw Error('Use --start YYYY-MM-DD --end YYYY-MM-DD');input[key.slice(2)]=process.argv[i+1];}
  const report=await diagnoseOrderValueDateScope(input,createOracleProviderDependencies());console.log(JSON.stringify(report,null,2));
  if(!report.date_counts_reconciled||!report.production_date_scope_reconciled)process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(JSON.stringify({status:'failed',failure:safeReadFailure(error,'population_query')}));process.exitCode=1;});
