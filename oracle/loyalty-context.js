import {loadLoyaltyConfig} from '../loyaltylion/runtime-config.js';
import {naturalReportPeriod} from './report-natural-period.js';
const configured=loadLoyaltyConfig();
const sections=['membership','tiers','points','claims','linkage'];
export function validateLoyaltyScope(v){
 if(v==null)return null;
 if(v.report_kind!=null&&!['overview','performance'].includes(v.report_kind)||v.performance_mtd!=null&&typeof v.performance_mtd!=='boolean')throw Error('Invalid loyalty scope');
 if(typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!['program_id','sections','tier_basis','tier','reward_use','purchase_values','report_kind','performance_mtd'].includes(k))||v.program_id!=null&&!/^\d+$/.test(v.program_id)||!Array.isArray(v.sections)||!v.sections.length||v.sections.some(x=>!sections.includes(x))||!['current','historical'].includes(v.tier_basis)||v.tier!=null&&(typeof v.tier!=='string'||!v.tier.trim()||v.tier.length>160||/@|\n/.test(v.tier))||typeof v.reward_use!=='boolean'||v.purchase_values!=null&&typeof v.purchase_values!=='boolean')throw Error('Invalid loyalty scope');
 return {...v,purchase_values:Boolean(v.purchase_values),sections:[...new Set(v.sections)]};
}
export function loyaltyContextPatch(base,text,now){
 const explicit=/\bloyalty\s*lion\b|\bloyalty (?:programme?|members?|tiers?|points|rewards?|report)\b/i.test(text),retained=base.requested_subject==='loyalty';
 const followup=retained&&!/\b(?:woocommerce|google|klaviyo|facebook|meta|instagram|inventory|shipping|collaboration|black friday|sales|revenue|conversion|products?)\b/i.test(text)&&(/^(?:now|only|just|and|also|instead|compare|show|use|give|export|download|by|daily|monthly|what about|for|last|this)\b/i.test(text)||Boolean(naturalReportPeriod(text,now)));
 if(!explicit&&!followup)return null;
 const performance=/\bloyalty\s*lion\b[\s\S]*\bperformance\b|\bloyalty performance report\b/i.test(text);
 const continuation=retained,previous=continuation?base.loyalty_scope:null,scope={program_id:previous?.program_id??configured.program_id,sections:previous?.sections||['membership','tiers','points','claims','linkage'],tier_basis:previous?.tier_basis||'current',tier:previous?.tier??null,reward_use:previous?.reward_use||false,purchase_values:previous?.purchase_values||false};
 if(performance||previous?.report_kind==='performance')Object.assign(scope,{report_kind:'performance',performance_mtd:previous?.performance_mtd??false});
 if(!performance&&/\boverview\b/i.test(text)){delete scope.report_kind;delete scope.performance_mtd;}
 const named=[];if(/\bmembers?(?:hip)?|enrol(?:led|ment)/i.test(text))named.push('membership');if(/\btiers?\b/i.test(text))named.push('tiers');if(/\bpoints?\b/i.test(text))named.push('points');if(/\b(?:reward|claim|redemption)s?\b/i.test(text))named.push('claims');if(/\b(?:purchas\w*|orders?|linkage|linked|spend|sales)\b/i.test(text))named.push('linkage');
 if(/\boverview|all sections\b/i.test(text))scope.sections=sections;else if(named.length&&!/\bonly\s+(?:gold|silver|platinum|diamond)\b/i.test(text))scope.sections=[...new Set(named)];
 if(/\b(?:historical|at (?:the )?(?:order|purchase)|held when|tier history)\b/i.test(text))scope.tier_basis='historical';else if(/\bcurrent\b/i.test(text))scope.tier_basis='current';
 if(/\b(?:actually (?:used|redeemed)|actual reward use|rewards? used|used rewards?|usage)\b/i.test(text))scope.reward_use=true;else if(/\bclaims? only|claimed rewards? only\b/i.test(text))scope.reward_use=false;
 const tier=text.match(/\btier\s+["']([^"']{1,100})["']/i)||text.match(/\b(?:only|just|tier)\s+(Gold|Silver|Platinum|Diamond)\b/i);if(tier)scope.tier=tier[1].toLowerCase();if(/\ball tiers\b/i.test(text))scope.tier=null;
 if(/\b(?:sales|revenue|spend|aov|average order value|repeat|frequency|retention|lifetime|uplift)\b/i.test(text))scope.purchase_values=true;else if(/\b(?:linkage|links?|order counts?) only\b/i.test(text))scope.purchase_values=false;
 const programme=text.match(/\bprogram(?:me)?\s+(\d+)\b/i);if(programme)scope.program_id=programme[1];
 let dates=naturalReportPeriod(text,now)||{};
 if(scope.report_kind==='performance'){
  scope.sections=sections;scope.purchase_values=false;
  if(!dates.start_date&&(!continuation||performance&&previous?.report_kind!=='performance')){
   const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now)),d=new Date(day+'T00:00:00Z');
   dates={start_date:new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()-12,1)).toISOString().slice(0,10),end_date:new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),0)).toISOString().slice(0,10)};
   scope.performance_mtd=true;
  }else if(dates.start_date)scope.performance_mtd=false;
 }
 const previousDates=continuation&&!(performance&&previous?.report_kind!=='performance')?{start_date:base.start_date,end_date:base.end_date,comparison_start_date:base.comparison_start_date,comparison_end_date:base.comparison_end_date,comparison_type:base.comparison_type}:{};
 let channel=continuation?base.channel:null,channel_breakdown=continuation?base.channel_breakdown:false;
 const pos=/\bpos\b|in[ -]?store/i.test(text),online=/\bonline\b/i.test(text);if(pos&&online||/\ball channels\b/i.test(text)){channel=null;channel_breakdown=true;}else if(pos){channel='instore';channel_breakdown=false;}else if(online){channel='online';channel_breakdown=false;}
 const currencies=[...new Set((text.toUpperCase().match(/\b(?:GBP|USD|EUR|JPY)\b/g)||[]))];
 return {continuation,patch:{...previousDates,...dates,requested_subject:'loyalty',analysis_type:'ecommerce',metrics:['loyalty'],tool_route:'get_loyalty_report',loyalty_scope:validateLoyaltyScope(scope),platform:'shopify',time_zone:'Europe/London',grain:/\bweekly|by week\b/i.test(text)?'week':/\bquarterly|by quarter\b/i.test(text)?'quarter':/\byearly|by year\b/i.test(text)?'year':/\bdaily|by day\b/i.test(text)?'day':/\bmonthly|by month\b/i.test(text)?'month':continuation?base.grain:null,channel,channel_breakdown,currencies:currencies.length?currencies:continuation?base.currencies:[],output_preference:/\b(?:export|excel|xlsx|spreadsheet)\b/i.test(text)?'xlsx':null,unresolved_required_fields:[]}};
}
