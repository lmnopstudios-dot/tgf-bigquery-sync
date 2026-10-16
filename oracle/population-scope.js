// Population membership and comparison are independent of metric and grouping.
const countries = [[/\b(?:UK|GB|United Kingdom|Britain)\b/i,'GB'],[/\b(?:US|USA|United States)\b/i,'US'],[/\bFrance\b/i,'FR'],[/\bGermany\b/i,'DE'],[/\bCanada\b/i,'CA'],[/\bAustralia\b/i,'AU'],[/\bJapan\b/i,'JP'],[/\bIreland\b/i,'IE']];
export function validatePopulationScope(value) {
  if(value==null)return null;
  if(!value||Object.keys(value).some(k=>!['geography_role','country','groups','comparison_country'].includes(k))||!['visitor_country','shipping_country','billing_country','storefront_market'].includes(value.geography_role)||value.country!==null&&!/^[A-Z]{2}$/.test(value.country)||!Array.isArray(value.groups)||!value.groups.length||value.groups.some(g=>!['country','global','rest_of_world','other_country'].includes(g))||new Set(value.groups).size!==value.groups.length)throw Object.assign(Error('Invalid population scope'),{code:'INVALID_ANALYSIS_CONTEXT'});
  if(value.comparison_country!==undefined&&!/^[A-Z]{2}$/.test(value.comparison_country))throw Object.assign(Error('Invalid comparison country'),{code:'INVALID_ANALYSIS_CONTEXT'});
  return {geography_role:value.geography_role,country:value.country,groups:[...value.groups],...(value.comparison_country?{comparison_country:value.comparison_country}:{})};
}
export function populationScopeIntent(text, previous) {
  const matched=[...new Set(countries.map(([re,code])=>({match:re.exec(text),code})).filter(x=>x.match).sort((a,b)=>a.match.index-b.match.index).map(x=>x.code))];
  const country=matched[0]||previous?.country||null;
  const global=/\b(?:global|worldwide|all (?:visitor )?countries|whole world)\b/i.test(text),rest=/\brest of (?:the )?world\b/i.test(text),local=countries.some(([re])=>re.test(text));
  if(!global&&!rest&&!local)return null;
  const role=/\bshipping|destination\b/i.test(text)?'shipping_country':/\bbilling\b/i.test(text)?'billing_country':/\bmarket|storefront|currency\b/i.test(text)?'storefront_market':/\b(?:visitors?|sessions?)\b/i.test(text)?'visitor_country':previous?.geography_role||'visitor_country';
  const compare=/\bcompar(?:e|ed|ing|ison)|\bversus\b|\bvs\b/i.test(text);
  const excludesLocal=local&&/\b(?:excluding|exclude|except|without)\b/i.test(text);
  const groups=global&&excludesLocal?(compare?['country','rest_of_world']:['rest_of_world']):rest?['country','rest_of_world']:global?(local||compare&&country||/\binstead\b/i.test(text)&&previous?.groups.includes('country')?['country','global']:['global']):['country'];
  return validatePopulationScope({geography_role:role,country,groups:matched.length>1&&compare&&!global&&!rest?['country','other_country']:groups,...(matched.length>1&&compare&&!global&&!rest?{comparison_country:matched[1]}:{})});
}
export const groupLabel=(scope,group)=>group==='global'?'Global (all available visitor countries'+(scope.country?', including '+(scope.country==='GB'?'UK':scope.country):'')+')':group==='other_country'?'Visitors: '+scope.comparison_country:group==='rest_of_world'?'Rest of world (excluding '+scope.country+')':scope.country==='GB'?'UK visitors':'Visitors: '+scope.country;
export const COUNTRY_CONVERSION_LIMITATION='Visitor-country conversion is unavailable for this request: a native country conversion numerator and compatible visitor sessions over a common reporting period could not be verified. Shipping/billing country, currency and storefront market cannot substitute for visitor geography. Actual country-conversion evidence cutoff: unavailable. No device rates or shipping-destination orders were substituted. No live collection, persisted source-data writes or backfill was attempted.';
