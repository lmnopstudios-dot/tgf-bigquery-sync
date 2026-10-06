import {naturalReportPeriod} from './report-natural-period.js';
const SOCIAL=new Set(['meta_ads','instagram']);
export function socialContextPatch(base,text,now){
 const retained=SOCIAL.has(base.requested_subject),ads=/\b(?:meta|facebook)\b.*\b(?:ads?|advertising|campaigns?|spend|roas|cpa)\b|\b(?:meta ads?|facebook ads?|ad sets?)\b/i.test(text)||/\bads?\b/i.test(text)&&(/\b(?:purchases?|cpa|roas|spend|lowest|highest)\b/i.test(text)||base.requested_subject==='meta_ads'),ig=/\binstagram\b.*\b(?:posts?|reels?|stories|saves?|organic|profile|website|followers?|account|content|views?|reach|performance|watch|video)\b|\b(?:reels?|stories)\b.*\b(?:profile|website|saves?|performance)\b/i.test(text),placement=/\bplacements?|instagram versus facebook|facebook versus instagram\b/i.test(text);
 const followup=retained&&!/\b(?:shopify|woocommerce|woo|google ads|klaviyo|sales|customers?|shipping|products?)\b/i.test(text)&&(/^(?:and\b|what about\b|break\b|compare\b|export\b|show\b|which\b|what changed\b)/i.test(text)||Boolean(naturalReportPeriod(text,now))||placement);
 const subject=ads||placement&&base.requested_subject==='meta_ads'&&!ig?'meta_ads':ig?'instagram':followup?base.requested_subject:null;
 if(!subject)return null;
 const continuation=base.requested_subject===subject,previous=continuation?base.social_scope:null;
 const scope=subject==='meta_ads'?{account_id:previous?.account_id||null,group_by:previous?.group_by||'account',breakdown:previous?.breakdown||'base',metric:previous?.metric||'spend',sort_direction:previous?.sort_direction||'desc',scope:null,media_type:null}:{account_id:previous?.account_id||null,group_by:null,breakdown:null,metric:previous?.metric||'views',sort_direction:'desc',scope:previous?.scope||'media',media_type:previous?.media_type||null};
 const account=text.match(/\baccount\s+(\d+)\b/i);if(account)scope.account_id=account[1];
 if(subject==='meta_ads'){
   if(/\bplacements?|instagram versus facebook|facebook versus instagram\b/i.test(text))scope.breakdown='placement';else if(/\bcountr(?:y|ies)\b/i.test(text))scope.breakdown='country';else if(/\bdevices?\b/i.test(text))scope.breakdown='device';else if(/\bbase totals?\b/i.test(text))scope.breakdown='base';
   for(const [pattern,group] of [[/\bcampaigns?\b/i,'campaign'],[/\bad[ -]?sets?\b/i,'adset'],[/\b(?:which|rank|lowest|best) ads?|by ad\b/i,'ad'],[/\bcreatives?\b/i,'creative'],[/\blanding[ -]?pages?|destinations?\b/i,'destination'],[/\bby month|monthly\b/i,'month']])if(pattern.test(text))scope.group_by=group;
   if(/\breach\b/i.test(text))scope.metric='reach';else if(/\bfrequency\b/i.test(text))scope.metric='frequency';else if(/\bcpa\b/i.test(text))scope.metric='cpa';else if(/\broas\b/i.test(text))scope.metric='roas';else if(/\b(?:attributed )?(?:revenue|value)\b/i.test(text))scope.metric='purchase_value';else if(/\bpurchases?\b/i.test(text))scope.metric='purchase_count';
   scope.sort_direction=/\blowest|cheapest|ascending\b/i.test(text)?'asc':/\bhighest|most|descending\b/i.test(text)?'desc':scope.sort_direction;
 }else{
   if(/\baccount|followers?|audience|follows?|unfollows?\b/i.test(text))scope.scope='account';else if(/\bposts?|content|reels?|stories\b/i.test(text))scope.scope='media';
   if(/\breels?\b/i.test(text))scope.media_type='REELS';else if(/\bstories\b/i.test(text))scope.media_type='STORY';else if(/\bcarousels?\b/i.test(text))scope.media_type='CAROUSEL_ALBUM';else if(/\ball (?:media|posts|content)\b/i.test(text))scope.media_type=null;
   for(const [pattern,metric] of [[/\bsaves?\b/i,'saved'],[/\bshares?\b/i,'shares'],[/\blikes?\b/i,'likes'],[/\bcomments?\b/i,'comments'],[/\breach\b/i,'reach'],[/\bviews?\b/i,'views'],[/\bprofile\b.*\b(?:activity|visits?|encouraged)\b|encouraged profile/i,'profile_activity'],[/\bwebsite|link activity\b/i,'profile_activity'],[/\baverage watch time\b/i,'ig_reels_avg_watch_time'],[/\btotal watch time\b/i,'ig_reels_video_view_total_time'],[/\bfollowers?\b/i,'followers_count'],[/\bfollows?\b.*\bunfollows?\b/i,'follows_and_unfollows']])if(pattern.test(text))scope.metric=metric;
 }
 let dates=naturalReportPeriod(text,now);
 const months={january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12},found=[...text.toLowerCase().matchAll(new RegExp(`\\b(${Object.keys(months).join('|')})\\b`,'g'))];
 if(found.length===2&&/\bcompare|changed|versus|vs\b/i.test(text)&&!dates){const year=Number(base.start_date?.slice(0,4)||new Date(now).getUTCFullYear()),window=m=>({start_date:`${year}-${String(m).padStart(2,'0')}-01`,end_date:new Date(Date.UTC(year,m,0)).toISOString().slice(0,10)}),a=window(months[found[1][1]]),b=window(months[found[0][1]]);dates={...a,comparison_type:'explicit_period_comparison',comparison_start_date:b.start_date,comparison_end_date:b.end_date};}
 if(!dates&&continuation)dates={start_date:base.start_date,end_date:base.end_date,comparison_type:base.comparison_type,comparison_start_date:base.comparison_start_date,comparison_end_date:base.comparison_end_date};
 return {...dates,requested_subject:subject,metrics:[subject],analysis_type:'ecommerce',platform:subject==='meta_ads'?'meta':'instagram',grain:scope.group_by==='month'?'month':'day',tool_route:subject==='meta_ads'?'get_meta_performance':'get_instagram_performance',social_scope:scope,output_preference:/\bexport|spreadsheet|xlsx\b/i.test(text)?'xlsx':null,limit:base.limit||100};
}
export function validateSocialScope(value){
 if(value==null)return null;
 if(typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['account_id','group_by','breakdown','metric','sort_direction','scope','media_type'].includes(k)))throw new Error('Invalid social scope');
 if(value.account_id!=null&&!/^\d+$/.test(value.account_id)||value.group_by!=null&&!['account','campaign','adset','ad','creative','destination','month'].includes(value.group_by)||value.breakdown!=null&&!['base','country','placement','device'].includes(value.breakdown)||!/^[a-z][a-z0-9_]{0,79}$/.test(value.metric||'')||!['asc','desc'].includes(value.sort_direction)||value.scope!=null&&!['account','media'].includes(value.scope)||value.media_type!=null&&!['IMAGE','VIDEO','CAROUSEL_ALBUM','REELS','STORY'].includes(value.media_type))throw new Error('Invalid social scope');
 return {...value};
}
