// Routing is deliberately local and deterministic: choosing a transport must
// never consume an agent turn or run a commerce-data tool.
export function oracleRequestRoute(message,{hasCompletedJob=false}={}) {
  const text=String(message||'').trim();
  const lower=text.toLowerCase();
  const words=text.split(/\s+/).filter(Boolean).length;
  if(!text)return 'chat';
  if(/\b(propose|save|remember|definition|rule|policy|hypothetical|what if)\b/i.test(text))return 'chat';
  if(hasCompletedJob&&words<=45)return 'chat';
  // A named product set plus performance and recommendation work predictably
  // needs several governed reads and a synthesis turn. Keep it off the short
  // interactive deadline even when the wording itself is brief.
  const multiProductRecommendation=/\b(?:recommend|upsell|cross[ -]?sell)\w*\b/i.test(text)
    && /\b(?:sales|performance|data|figures|revenue|units)\b/i.test(text)
    && ((text.match(/[,;]/g)||[]).length>=2||/\b(?:and|versus|vs\.?|compared? (?:with|to))\b/i.test(text));
  if(multiProductRecommendation)return 'job';
  const separators=(text.match(/[;,]/g)||[]).length;
  const scopeTerms=(lower.match(/\b(stock|inventory|sales|product|products|items|catalogue|online)\b/g)||[]).length;
  const analytical=/\b(analy[sz]e|analysis|investigate|recommend|strategy|clear(?:ing|ance)?|use data|across|complete|comprehensive)\b/i.test(text);
  const score=(text.length>=300?1:0)+(words>=65?1:0)+(separators>=7?2:separators>=4?1:0)+(scopeTerms>=3?1:0)+(analytical?1:0);
  return score>=4?'job':'chat';
}
