import { ANALYSIS_TOOL_ROUTES, validateAnalysisContext } from './analysis-context.js';

const baselineThenAgent = async ({message,baselineOverview,baselineOptions,chat,chatOptions}) =>
  await baselineOverview?.(message,baselineOptions) || await chat(message,chatOptions);

const governedBaseline = async ({message,baselineOverview,baselineOptions}) => {
  const result=await baselineOverview?.(message,baselineOptions);
  if(result)return result;
  throw Object.assign(new Error('The governed analysis route has no executable evidence binding.'),{code:'ANALYSIS_ROUTE_UNAVAILABLE'});
};

// This is the single registration point shared by context validation tests and
// request delivery. Values are executable bindings, rather than descriptive
// route names, so a deterministic transition cannot silently become orphaned.
export const ANALYSIS_ROUTE_DISPATCHERS = Object.freeze(Object.fromEntries(ANALYSIS_TOOL_ROUTES.map(route=>[
  route,
  ['get_woocommerce_device_conversion','get_governed_device_conversion'].includes(route)
    ? governedBaseline
    : baselineThenAgent
])));

export async function dispatchAnalysisRequest({message,analysisContext,baselineOverview=null,baselineOptions,chat,chatOptions}){
  const context=analysisContext==null?null:validateAnalysisContext(analysisContext);
  const binding=context?.tool_route?ANALYSIS_ROUTE_DISPATCHERS[context.tool_route]:baselineThenAgent;
  return binding({message,baselineOverview,baselineOptions,chat,chatOptions});
}
