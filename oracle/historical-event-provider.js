import {createEventSaleProvider} from './event-sale-provider.js';
import {createEventSaleReportService} from './event-sale-report.js';
import { createOnlineCountrySalesService, SHOPIFY_NATIVE_HISTORY_START } from './online-country-sales.js';
import { createHistoricalEventComparisonService } from './historical-event-comparison.js';
const safeCode=error=>/^[A-Z][A-Z0-9_]{0,63}$/.test(String(error?.code))?error.code:'EVENT_SOURCE_READ_FAILED';
/** Same production factory for HTTP, direct agent, durable execution and diagnostics.
 * Source-specific failures cannot discard another source's independent evidence.
 * Reads use existing authority/deduplication rules, including legitimate overlap.
 */
export function createHistoricalEventDependencies({bigquery,project,knowledgeService,now,onlineSales=null,saleProvider=null}){
  const provider=onlineSales||createOnlineCountrySalesService({bigquery,project});
  const collectEvent=async event=>{
    const platforms=event.end_date<SHOPIFY_NATIVE_HISTORY_START?['woo']:['woo','shopify'];
    const source_components=await Promise.all(platforms.map(async platform=>{
      try{return {platform,status:'fulfilled',evidence:await provider({start_date:event.start_date,end_date:event.end_date,currency:null,platform})};}
      catch(error){return {platform,status:'rejected',error_code:safeCode(error)};}
    }));
    return {source_components,online_sales:{rows:source_components.filter(c=>c.status==='fulfilled').flatMap(c=>c.evidence.rows)},partial:source_components.some(c=>c.status==='rejected'),coverage_complete:false};
  };
  const legacy=createHistoricalEventComparisonService({knowledgeService,collectEvent,...(now?{now}:{})});
  const scoped=createEventSaleReportService({knowledgeService,provider:saleProvider||createEventSaleProvider({bigquery,project}),...(now?{now}:{})});
  return {collectEvent,historicalEventComparison:(message,options={})=>options.analysisContext?.event_scope?scoped(message,options):legacy(message,options)};
}
