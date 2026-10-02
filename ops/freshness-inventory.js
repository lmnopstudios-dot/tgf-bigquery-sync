#!/usr/bin/env node
import {BigQuery} from '@google-cloud/bigquery';
import {ORACLE_SOURCE_CONTRACTS,freshnessAssessment} from '../oracle/freshness.js';
import {ensureControl,coverageSql,CONTROL_DATASET} from './collector-runner.js';

export function retiredCoverageSql(project,source){
  if(source!=='woo_metorik_retired')return null;
  return `SELECT CAST(MIN(order_date) AS STRING) coverage_start,CAST(MAX(order_date) AS STRING) coverage_end FROM (
    SELECT DATE(order_created_at) order_date FROM \`${project}.metorik_uk.orders\`
    UNION ALL
    SELECT DATE(order_created_at) order_date FROM \`${project}.metorik_us.orders\`
  )`;
}

export async function inventory({bigquery,project,now=new Date()}){
  await ensureControl(bigquery,project);
  const out=[];
  for(const [source,contract] of Object.entries(ORACLE_SOURCE_CONTRACTS)){
    if(contract.retired){
      let coverageStart=null,coverageEnd=null;
      const query=retiredCoverageSql(project,source);
      const execution_evidence=[];
      if(query)try{
        const [rows]=await bigquery.query({query});
        coverageStart=rows[0]?.coverage_start||null;
        coverageEnd=rows[0]?.coverage_end||null;
      }catch(error){execution_evidence.push({status:'historical_coverage_inspection_failed',error:error.message.slice(0,300)});}
      out.push({...contract,source,historical_coverage:{start:coverageStart,end:coverageEnd},actual_last_successful_source_collection:null,execution_evidence,recurring_collection:'retired_no_schedule',assessment:freshnessAssessment({source,coverageStart,coverageEnd,status:'retired',now})});
      continue;
    }
    let coverageEnd=null,coverageStart=null,lastSuccess=null,status='missing',execution_evidence=[];
    try{
      const [coverage]=await bigquery.query({query:coverageSql(project,source).replace('MAX(','MIN(')});
      coverageStart=coverage[0]?.coverage_end;
      const [end]=await bigquery.query({query:coverageSql(project,source)});
      coverageEnd=end[0]?.coverage_end;
      const [runs]=await bigquery.query({query:`SELECT status,started_at,finished_at,window_start,window_end FROM \`${project}.${CONTROL_DATASET}.collector_runs\` WHERE source=@source ORDER BY started_at DESC LIMIT 5`,params:{source}});
      execution_evidence=runs;
      const success=runs.find(row=>row.status==='succeeded');
      lastSuccess=success?.finished_at;
      status=runs[0]?.status||'missing';
    }catch(error){execution_evidence=[{status:'inspection_failed',error:error.message.slice(0,300)}];}
    out.push({...contract,source,historical_coverage:{start:coverageStart,end:coverageEnd},actual_last_successful_source_collection:lastSuccess,execution_evidence,assessment:freshnessAssessment({source,coverageStart,coverageEnd,lastSuccess,status,now})});
  }
  return out;
}

async function main(){const credentials=JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),project=process.env.GOOGLE_PROJECT_ID||credentials.project_id;console.log(JSON.stringify(await inventory({project,bigquery:new BigQuery({projectId:project,credentials})}),null,2));}
if(import.meta.url===`file://${process.argv[1]}`)main().catch(error=>{console.error(error.message);process.exitCode=1;});
