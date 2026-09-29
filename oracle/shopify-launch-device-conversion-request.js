import { datesBetween } from '../ga4/semantic.js';

export const SHOPIFY_LAUNCH_COMPARISON_TOOL='compare_device_conversion_before_after_shopify';
export const SHOPIFY_LAUNCH_COMPARISON_ARGS=Object.freeze({before_start:'2025-09-25',before_end:'2025-11-19',after_start:'2025-11-20',after_end:'2026-01-14'});

export function classifyShopifyLaunchDeviceConversionRequest(message){
  const text=String(message||'').toLowerCase();
  if(!text.includes('desktop')||!text.includes('mobile')||!text.includes('56 days')||!text.includes('shopify launch')||!text.includes('20 november 2025'))return null;
  return{classification:'shopify_launch_device_conversion',tool:SHOPIFY_LAUNCH_COMPARISON_TOOL,args:{...SHOPIFY_LAUNCH_COMPARISON_ARGS}};
}

const integer=value=>Number(value).toLocaleString('en-GB',{maximumFractionDigits:0});
const percent=value=>`${(Number(value)*100).toFixed(2)}%`;

export function synthesizeShopifyLaunchDeviceConversionAnswer(result,args=SHOPIFY_LAUNCH_COMPARISON_ARGS){
  if(result?.question!==SHOPIFY_LAUNCH_COMPARISON_TOOL)throw new Error('Unexpected launch comparison result');
  for(const [key,value] of Object.entries(args))if(result.periods?.[key]!==value)throw new Error('Launch comparison dates do not match the governed window');
  const expected=datesBetween(args.before_start,args.before_end).length;
  if(expected!==56||datesBetween(args.after_start,args.after_end).length!==56)throw new Error('Governed launch windows must each contain 56 days');
  const rows=Array.isArray(result.rows)?result.rows:[];
  const lines=['Desktop and mobile conversion around the public Shopify launch:'];
  for(const period of ['before','after']){
    const dates=period==='before'?`${args.before_start} to ${args.before_end}`:`${args.after_start} to ${args.after_end}`;
    const metric=period==='before'?'ecommerce purchases per session':'completed-checkout sessions per session';
    lines.push(`\n${period==='before'?'Woo GA4':'Shopify'} — ${dates} (56 days) — ${metric}:`);
    for(const device of ['desktop','mobile']){
      const row=rows.find(item=>item.period===period&&String(item.device_type).toLowerCase()===device);
      if(!row||row.coverage?.complete!==true||Number(row.coverage?.covered_days)!==56)throw new Error(`Complete ${period} ${device} device coverage is required`);
      if(row.rate==null)throw new Error(`A complete ${period} ${device} rate is required`);
      lines.push(`- ${device[0].toUpperCase()}${device.slice(1)}: ${integer(row.sessions)} sessions; ${integer(row.numerator)} ${period==='before'?'ecommerce purchases':'completed-checkout sessions'}; ${percent(row.rate)}; ${integer(row.coverage.covered_days)} of 56 covered days.`);
    }
  }
  if(result.cross_platform_percentage_point_difference!==null||!String(result.comparability||'').startsWith('not_established'))throw new Error('Cross-platform comparability has not been established');
  lines.push('\nNo cross-platform percentage-point change is calculated: GA4 ecommerce purchases and Shopify completed-checkout sessions are different populations.');
  return lines.join('\n');
}

export async function answerShopifyLaunchDeviceConversionRequest(message,service){
  const route=classifyShopifyLaunchDeviceConversionRequest(message);if(!route)return null;
  const result=await service(route.tool,route.args);
  return{route,result,answer:synthesizeShopifyLaunchDeviceConversionAnswer(result,route.args)};
}
