import { ANALYTICAL_CAPABILITIES } from './analytical-capabilities.js';
import { ANALYSIS_ROUTE_DISPATCHERS } from './analysis-route-dispatcher.js';

/** Inspect executable bindings, without performing provider reads. */
export function orderValueRuntimeBinding({orderValues,baselineOverview}) {
  return {registered:Boolean(ANALYTICAL_CAPABILITIES.get_order_value_analysis),provider_bound:typeof orderValues==='function',dispatcher_bound:typeof ANALYSIS_ROUTE_DISPATCHERS.get_order_value_analysis==='function'&&typeof baselineOverview==='function',synthesis:'validated_aggregate'};
}
