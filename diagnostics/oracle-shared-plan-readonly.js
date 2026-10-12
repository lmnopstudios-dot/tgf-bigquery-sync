/** Explicitly bounded reads only. No server import, setup, collection or inventory dependency. */
import { pathToFileURL } from 'node:url';
import { createBigQueryClient } from '../bigquery/client.js';
import { createOracleProviderDependencies } from '../oracle/provider-dependencies.js';
import { createKnowledgeService } from '../oracle/knowledge-bigquery.js';
import { createPriorityShopifyTransport } from '../oracle/product-priority-production.js';
import { createShopifySalesKpiService, createDailySalesProvider } from '../oracle/daily-sales-provider.js';
import { fetchPublishedProducts } from '../oracle/product-priority.js';
import { selectCataloguePopulation } from '../oracle/product-catalogue-filter.js';
import { resolveProductReportConfig } from '../oracle/product-report-config.js';
import { resolvePromotionDates, retrievePromotionContext } from '../oracle/promotion-context.js';
import { assertEvidenceAgreement } from '../oracle/analysis-route-dispatcher.js';
import { ORACLE_JOB_DEFAULTS } from '../oracle/analysis-jobs.js';

const identifier=value=>{if(!/^[A-Za-z0-9_-]+$/.test(value))throw Error('Invalid identifier');return value;};
const json=value=>typeof value==='string'?JSON.parse(value):value;
export function validateReadOnlyDiagnostic(input) {
  const allowed={sales:['mode','start','end'],promotion:['mode','start','end','query'],campaign:['mode','name','cutoff'],catalogue:['mode','category'],job:['mode','job-id']}[input.mode];
  if(!allowed||Object.keys(input).some(k=>!allowed.includes(k)))throw Error('Use sales, promotion, campaign, catalogue or job with only the documented arguments.');
  if(['sales','promotion'].includes(input.mode)){
    for(const d of [input.start,input.end])if(!/^\d{4}-\d{2}-\d{2}$/.test(d||'')||new Date(`${d}T00:00:00Z`).toISOString().slice(0,10)!==d)throw Error('Valid start/end dates are required');
    const days=(Date.parse(input.end)-Date.parse(input.start))/86400000+1;
    if(days<1||days>(input.mode==='sales'?31:366))throw Error('Bound: sales 1–31 days; promotion 1–366 days.');
  }
  if(input.mode==='job'&&!/^[0-9a-f-]{36}$/.test(input['job-id']||''))throw Error('One known UUID job-id is required');
  if(input.mode==='promotion'&&(!input.query||input.query.length>160))throw Error('A bounded promotion query is required');
  if(input.mode==='catalogue'&&(!input.category||input.category.length>80))throw Error('A bounded category is required');
  if(input.mode==='campaign'&&input.name?.length>160)throw Error('Campaign name is too long');
  if(input.cutoff&&!Number.isFinite(Date.parse(input.cutoff)))throw Error('Invalid cutoff');
  return input;
}
export async function readOnlyDiagnostic(input,{dailySales,klaviyo,knowledgeService,graphql,bigquery,project,jobDataset=ORACLE_JOB_DEFAULTS.dataset,jobTable=ORACLE_JOB_DEFAULTS.table}) {
  validateReadOnlyDiagnostic(input);
  const period={start_date:input.start,end_date:input.end};
  if(input.mode==='sales'){
    const e=await dailySales({...period,platform:'shopify',channel:'online',reporting_timezone:'Europe/London',currencies:[],source_store:null});
    return {mode:'sales',period:e.period,grain:e.grain,source_store:e.source_store,channel:e.channel,currency:e.currency,reporting_timezone:e.reporting_timezone,timezone_semantics:e.timezone_semantics,coverage:e.coverage,definitions:e.definitions,returned_days:e.rows.length,first_day:e.rows[0]?.date,last_day:e.rows.at(-1)?.date,rows:e.rows};
  }
  if(input.mode==='promotion')return {mode:'promotion',period,...resolvePromotionDates(await retrievePromotionContext(knowledgeService,{query:input.query},period),{query:input.query,treatment:'compare_excluding'},period)};
  if(input.mode==='campaign'){
    const r=await klaviyo.resolveCampaigns({name:input.name||null,channel:'email',cutoff:input.cutoff||new Date().toISOString()});
    return {mode:'campaign',complete:r.complete,candidates:r.candidates.slice(0,10).map(c=>Object.fromEntries(['entity_id','entity_name','account','channel','status','is_sent','send_time','send_time_semantics','reporting_timezone','reporting_cutoff','retrieved_at'].map(k=>[k,c[k]]))),omitted_candidates:Math.max(0,r.candidates.length-10)};
  }
  if(input.mode==='catalogue'){
    let calls=0,pages=0;
    const catalogue=await fetchPublishedProducts(async(...args)=>{if(/products\(first:100/.test(args[0])&&++pages>7)throw Object.assign(Error('Seven root pages maximum'),{code:'DIAGNOSTIC_READ_BOUND'});if(++calls>25)throw Object.assign(Error('Read-only diagnostic call bound'),{code:'DIAGNOSTIC_READ_BOUND'});return graphql(...args);},{inspectClassification:true});
    const config=resolveProductReportConfig(`Export Shopify ${input.category} by units sold.`,{now:Date.now()}).config,selected=selectCataloguePopulation(catalogue,config);
    return {mode:'catalogue',calls,complete:catalogue.complete,pages:catalogue.pages,root_products:catalogue.products.length,selection:selected.selection||null,clarification:selected.clarification||null};
  }
  const table=`\`${identifier(project)}.${identifier(jobDataset)}.${identifier(jobTable)}\``;
  const [rows]=await bigquery.query({query:`SELECT job_id,status,error_code,JSON_QUERY(payload_json,'$.analysis_context') analysis_context,JSON_QUERY(result_json,'$.analysis_context') resolved_context,JSON_QUERY(result_json,'$.evidence') evidence FROM ${table} WHERE job_id=@job_id LIMIT 1`,params:{job_id:input['job-id']},maximumBytesBilled:'500000000',useLegacySql:false,labels:{component:'oracle_readonly_diagnostic'}});
  if(!rows.length)return {mode:'job',found:false};
  const row=rows[0],context=json(row.resolved_context)||json(row.analysis_context),e=json(row.evidence);let agreement='no evidence';
  if(e){try{assertEvidenceAgreement(context,e);agreement='validated';}catch(error){agreement=error.code||'EVIDENCE_SCOPE_MISMATCH';}}
  return {mode:'job',found:true,job_id:row.job_id,status:row.status,error_code:row.error_code,context,evidence_agreement:agreement,evidence:e?{kind:e.kind,periods:e.periods,dimensions:e.dimensions,channel:e.channel,currency:e.currency,campaign:e.campaign,catalogue_selection:e.catalogue_selection,row_count:e.rows?.length,coverage:e.coverage,applied_exclusions:e.applied_exclusions}:null};
}
async function main(){
  const args=process.argv.slice(2),input={};for(let i=0;i<args.length;i+=2){if(!args[i].startsWith('--')||!args[i+1])throw Error('Every option requires one value');input[args[i].slice(2)]=args[i+1];}validateReadOnlyDiagnostic(input);
  const env=process.env,deps={};
  if(['sales','catalogue'].includes(input.mode)){
    const transport=createPriorityShopifyTransport({shop:env.SHOPIFY_SHOP,clientId:env.SHOPIFY_CLIENT_ID,clientSecret:env.SHOPIFY_CLIENT_SECRET});let calls=0;
    const graphql=(...args)=>{if(++calls>25)throw Error('Maximum 25 Shopify read requests');return transport(...args);};deps.graphql=graphql;
    deps.dailySales=createDailySalesProvider({shopifySales:createShopifySalesKpiService({getShop:async()=>(await graphql('{ shop { id currencyCode ianaTimezone } }',{})).shop,runReport:async query=>{
      const response=(await graphql('query Sales($query:String!){shopifyqlQuery(query:$query){tableData{columns{name dataType} rows} parseErrors}}',{query})).shopifyqlQuery;
      if(response?.parseErrors?.length||!response?.tableData)throw Error('ShopifyQL daily sales read rejected');
      const {columns,rows}=response.tableData;return rows.map(row=>Object.fromEntries(columns.map((c,i)=>[c.name,Array.isArray(row)?row[i]:row[c.name]])));
    }})});
  }else{
    Object.assign(deps,createBigQueryClient(env));
    if(input.mode==='campaign')deps.klaviyo=createOracleProviderDependencies({...deps,env}).klaviyo;
    if(input.mode==='promotion')deps.knowledgeService=createKnowledgeService(deps);
    if(input.mode==='job'){deps.jobDataset=env.ORACLE_JOB_DATASET||ORACLE_JOB_DEFAULTS.dataset;deps.jobTable=env.ORACLE_JOB_TABLE||ORACLE_JOB_DEFAULTS.table;}
  }
  console.log(JSON.stringify(await readOnlyDiagnostic(input,deps),null,2));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(JSON.stringify({status:'unavailable',code:String(error.code||error.name).replace(/[^A-Za-z0-9_]/g,'').slice(0,60)}));process.exitCode=1;});
