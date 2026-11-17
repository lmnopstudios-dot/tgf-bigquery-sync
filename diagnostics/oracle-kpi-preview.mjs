// Read-only diagnostic: never persists an export, changes coverage or collects source data.
import {createBigQueryClient} from '../bigquery/client.js';
import {createKpiReader,kpiCommerceSql,kpiRetentionSql,reviewedKpiCoverage} from '../oracle/kpi-reader.js';
import {transitionAnalysisContext} from '../oracle/analysis-context.js';
import {kpiPeriods} from '../public/oracle/kpi-intent.js';
import {buildKpiEvidence,baselinePeriod} from '../oracle/kpi-dashboard.js';
import {datasetLocation} from '../bigquery/dataset-location.js';
const apply=process.argv.includes('--execute-read-only'),now=Date.now();
const message=process.argv.find(v=>v.startsWith('KPI '))||'KPI dashboard';
try{
 const {bigquery,project}=createBigQueryClient(),context=transitionAnalysisContext(null,message,{now}).context;
 if(context.period_issue||context.tool_route!=='get_kpi_dashboard')throw Error('KPI_INVALID_SCOPE');
 const coverage=reviewedKpiCoverage(),baseline=baselinePeriod(coverage,context.kpi_scope.channel,process.env.ORACLE_KPI_BASELINE_START),periods=kpiPeriods(context.start_date,context.end_date,now);if(baseline)periods.push(baseline);
 const signal=AbortSignal.timeout(60000),deadlineAt=Date.now()+60000;
 if(!apply){const location=await datasetLocation(bigquery,project,'shopify_data');for(const query of [kpiCommerceSql(project),kpiRetentionSql(project)])await bigquery.createQueryJob({query,dryRun:true,params:{windows:JSON.stringify(periods),channel:context.kpi_scope.channel,currency:context.kpi_scope.currency,as_of:new Date(now).toISOString(),matrixify_app_id:'gid://shopify/App/1758145'},types:{windows:'STRING',channel:'STRING',currency:'STRING',as_of:'STRING',matrixify_app_id:'STRING'},location,useLegacySql:false,maximumBytesBilled:'1000000000'});console.log(JSON.stringify({read_only:true,warehouse_writes:false,dry_run:true,queries:2,status:'sql_validated'}));}
 else{const data=await createKpiReader({bigquery,project})({periods,scope:context.kpi_scope,now,signal,deadlineAt}),e=buildKpiEvidence({context,periods,data,coverage,baseline,now});console.log(JSON.stringify({read_only:true,warehouse_writes:false,source_status:e.source_status,periods:e.periods,baseline:e.baseline,supported_values:e.summary.filter(r=>r.status==='supported').length,unavailable_values:e.summary.filter(r=>r.status!=='supported').length}));}
}catch(error){console.log(JSON.stringify({read_only:true,warehouse_writes:false,status:'failed',code:['KPI_INVALID_SCOPE','KPI_BASELINE_INVALID'].includes(error.message)?error.message:'KPI_VALIDATION_FAILED',reason:['invalidQuery','accessDenied','notFound'].includes(error.errors?.[0]?.reason)?error.errors[0].reason:null}));process.exitCode=1;}
