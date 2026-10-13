/** Read-only runtime factory/selection acceptance. No server or collector import. */
import {createOracleProviderDependencies} from '../oracle/provider-dependencies.js';
import {createBaselineOverviewService} from '../oracle/baseline-overview.js';
import {createOracleBaselineDispatcher} from '../oracle/baseline-dispatcher.js';
import {orderValueRuntimeBinding} from '../oracle/runtime-capability-bindings.js';
import {transitionAnalysisContext} from '../oracle/analysis-context.js';
import {resolveExecutionPlan} from '../oracle/analytical-capabilities.js';
const providers=createOracleProviderDependencies();
const baselineOverview=createOracleBaselineDispatcher({ecommerceBaselineOverview:createBaselineOverviewService(providers)});
const message='Assess UK online GBP free shipping for September 2026. Compare £250 with £200 and £225, assuming purchasing behaviour stays unchanged. Show affected order counts, recorded shipping charges and the separate hypothetical £8 calculation. State the order-value basis and any unknown values.';
let context=transitionAnalysisContext(null,message).context;
const selections=[];
for(const next of [null,'Try £175','Just August','Show the bands','Export that']){
 if(next)context=transitionAnalysisContext(context,next).context;
 const execution=resolveExecutionPlan(context);
 selections.push({selected_route:context.tool_route,delivery:execution.delivery,period:{start_date:context.start_date,end_date:context.end_date},country:context.geography,currencies:context.currencies,channel:context.channel,basis:context.numeric_operation?.basis,thresholds:context.numeric_operation?.thresholds,assumed_charge:context.numeric_operation?.assumed_charge,limitation:Boolean(execution.limitation)});
}
console.log(JSON.stringify({read_only:true,provider_calls:0,deployed_revision:process.env.RENDER_GIT_COMMIT||null,binding:orderValueRuntimeBinding({orderValues:providers.orderValues,baselineOverview}),selections}));
if(selections.some(s=>s.selected_route!=='get_order_value_analysis'||s.limitation))process.exitCode=1;
