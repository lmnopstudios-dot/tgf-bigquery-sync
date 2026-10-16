#!/usr/bin/env node
// Run from a repository revision containing this file. Does not import server.js.
import { pathToFileURL } from 'node:url';
import { createOracleProviderDependencies } from '../oracle/provider-dependencies.js';
import { COUNTRY_READER_BOUNDS } from '../oracle/shopify-country-conversion.js';
import { aggregatePopulationConversion } from '../oracle/population-conversion.js';
import { transitionAnalysisContext } from '../oracle/analysis-context.js';
export function probeArgs(argv){
  const values={};for(let i=0;i<argv.length;i+=2){if(!['--start','--end','--country'].includes(argv[i])||!argv[i+1]||Object.hasOwn(values,argv[i]))throw Error('Use --start YYYY-MM-DD --end YYYY-MM-DD [--country GB]');values[argv[i]]=argv[i+1];}
  if(!values['--start']||!values['--end']||!(/^[A-Z]{2}$/).test(values['--country']||'GB'))throw Error('Explicit bounded dates and a two-letter visitor-country code are required');
  return {start_date:values['--start'],end_date:values['--end'],population_scope:{geography_role:'visitor_country',country:values['--country']||'GB',groups:['country','global']},channel:'online',dimensions:[]};
}
export async function runCountryProbe(args,{env=process.env,now=()=>new Date(),...injections}={}){
  const deps=createOracleProviderDependencies({env,bigquery:{query:()=>{throw Error('Warehouse calls forbidden in country probe');}},project:env.GOOGLE_PROJECT_ID||'gf-full-data',now,...injections});
  const source=await deps.populationConversion(args);
  const report={diagnostic:'oracle_visitor_country_capability',read_only:true,collection:false,source_data_writes:false,bounds:COUNTRY_READER_BOUNDS,requested:args,capability_supported:source.supported,graphql_calls:source.graphql_calls,actual_evidence_cutoff:source.coverage?.last_compatible_day||null};
  if(!source.supported)return {...report,failure:source.failure||{stage:'coverage_validation',code:'NO_COMPATIBLE_REPORT_DAYS'}};
  const context={...transitionAnalysisContext(null,'UK visitor conversion versus global',{now:+new Date(now())}).context,...args,dimensions:[],filters:[],exclusions:[],time_zone:source.shop.ianaTimezone};
  return {...report,reporting_timezone:source.shop.ianaTimezone,definitions:{numerator:'Shopify native sessions_that_completed_checkout',denominator:'Shopify native sessions',geography:'visitor/session country',bot_filter:'human',global:'unfiltered visitor countries including UK and unknown',rate:'sum numerator / sum denominator'},coverage:source.coverage,comparisons:aggregatePopulationConversion(context,source),live_acceptance:'Source report availability only; not deployed Oracle/browser delivery. Historical coverage is established only for the compatible report days returned in this requested window.'};
}
export async function main(argv=process.argv.slice(2)){
  const report=await runCountryProbe(probeArgs(argv));console.log(JSON.stringify(report,null,2));if(!report.capability_supported)process.exitCode=1;
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href)main().catch(()=>{console.error(JSON.stringify({diagnostic:'oracle_visitor_country_capability',read_only:true,capability_supported:false,failure:{stage:'input_or_configuration',code:'PROBE_FAILED'},details:'Use explicit dates, at most 366 days, and the existing configured runtime. No collection or source-data writes were attempted.'}));process.exitCode=1;});
