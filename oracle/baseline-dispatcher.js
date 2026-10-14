import { transitionAnalysisContext } from './analysis-context.js';
import { messageIntent, nonAnalyticalResult } from './message-intent.js';
/** Honor resolved capabilities before legacy message recognizers. All transports
 * use this production composition; unresolved general questions retain tooling. */
export function createOracleBaselineDispatcher({currentStock,productPriorityExport,generalAnalytics,historicalEventComparison,ecommerceBaselineOverview,productEvidenceReport}) {
  const routes={compare_historical_events:historicalEventComparison,get_shopify_inventory_by_location:currentStock,export_product_priorities:productPriorityExport,get_general_sales_analysis:generalAnalytics,get_product_sales_analysis:generalAnalytics,get_order_value_analysis:ecommerceBaselineOverview,get_daily_sales_analysis:ecommerceBaselineOverview};
  return async(message,options={})=>{
    const intent=messageIntent(message);if(intent.blocked)return nonAnalyticalResult(message);if(intent.document){message=intent.instruction;options={...options,analysisContext:transitionAnalysisContext(null,message).context};}
    const route=options.analysisContext?.tool_route;
    if(routes[route])return routes[route](message,options);
    for(const service of [currentStock,productPriorityExport,generalAnalytics,historicalEventComparison,ecommerceBaselineOverview,productEvidenceReport]){
      const result=await service?.(message,options);if(result)return result;
    }
    return null;
  };
}
