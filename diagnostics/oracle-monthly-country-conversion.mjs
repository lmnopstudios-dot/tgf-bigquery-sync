#!/usr/bin/env node
// Read-only source probe: no server, warehouse, collector, inventory or setup.
import { createCountryConversionReportReader, COUNTRY_REPORT_BOUNDS } from '../oracle/country-conversion-report.js';
import { transitionAnalysisContext } from '../oracle/analysis-context.js';
import { answerPopulationConversion } from '../oracle/population-conversion.js';
import { withOracleCharts } from '../oracle/evidence-charts.js';
const args=Object.fromEntries(process.argv.slice(2).map(arg=>{
  const match=arg.match(/^--(start|end|population)=(.+)$/);if(!match)throw Error('Use --start=YYYY-MM-DD --end=YYYY-MM-DD --population=rest_of_world|global');return match.slice(1);
}));
if(!args.start||!args.end||![undefined,'rest_of_world','global'].includes(args.population))throw Error('Explicit dates and a supported comparison population are required');
const now=new Date(),context=transitionAnalysisContext(null,`Monthly UK visitor conversion versus ${args.population==='global'?'global':'rest of world'} ${args.start} to ${args.end}`,{now:+now}).context;
if(context.start_date!==args.start||context.end_date!==args.end)throw Error('Dates did not resolve exactly');
const provider=createCountryConversionReportReader({now:()=>now});
const result=withOracleCharts(await answerPopulationConversion({context,provider}));
console.log(JSON.stringify({diagnostic:'oracle_monthly_visitor_country_conversion',read_only:true,bounds:COUNTRY_REPORT_BOUNDS,configured:provider.capability.configured,requested:{start:args.start,end:args.end,grouping:context.grain,populations:context.population_scope},supported:Boolean(result.evidence),partial:result.partial||false,graphql_calls:result.evidence?.source.graphql_calls,coverage:result.evidence?.source.coverage,monthly_rows:result.evidence?.sections,charts:result.charts,capability_status:result.capability_status,answer:result.answer,live_acceptance:'Native source/report verification only; deployed direct, interactive and durable browser delivery must be checked separately.'},null,2));
if(!result.evidence)process.exitCode=1;
