const months=['january','february','march','april','may','june','july','august','september','october','november','december'];
export const validSaleDay=d=>/^20\d{2}-\d{2}-\d{2}$/.test(d||'')&&Number.isFinite(Date.parse(d+'T00:00:00Z'))&&new Date(d+'T00:00:00Z').toISOString().slice(0,10)===d;
export function validateShopifySaleWindow(w){
 if(!w||Object.keys(w).some(k=>!['name','start_date','end_date','timezone','product_limit','pos_population'].includes(k))||typeof w.name!=='string'||!w.name.length||w.name.length>100||!validSaleDay(w.start_date)||!validSaleDay(w.end_date)||w.end_date<w.start_date||Date.parse(w.end_date)-Date.parse(w.start_date)>92*86400000||w.timezone!=='Europe/London'||!Number.isInteger(w.product_limit)||w.product_limit<1||w.product_limit>100||w.pos_population!=='all_recorded')throw Object.assign(Error('Invalid sale window'),{code:'INVALID_ANALYSIS_CONTEXT'});
 return {...w};
}
export function explicitShopifySaleScope(text,base){
 const t=String(text).replaceAll('**','');
 if(!/\bsale\b/i.test(t)||! /\bShopify\b/i.test(t)||/\bBlack Friday\b/i.test(t))return null;
 const iso=t.match(/\b(20\d{2}-\d{2}-\d{2})\s*(?:to|through|[-–—])\s*(20\d{2}-\d{2}-\d{2})\b/);
 const m=t.match(/\b(\d{1,2})(?:\s+([a-z]+)(?:\s+(20\d{2}))?)?\s*(?:[-–—]|to|through)\s*(\d{1,2})\s+([a-z]+)\s+(20\d{2})\b/i);
 const day=(d,mo,y)=>`${y}-${String(months.indexOf(mo.toLowerCase())+1).padStart(2,'0')}-${d.padStart(2,'0')}`;
 const start=iso?.[1]||(m?day(m[1],m[2]||m[5],m[3]||m[6]):null),end=iso?.[2]||(m?day(m[4],m[5],m[6]):null);
 if(!start||!end)return null;
 const count=Number(t.match(/\btop\s+(\d{1,3})\s+products?\b/i)?.[1]||20);
 const month=months[Number(start.slice(5,7))-1]||'specified',season=t.match(/\b(?:summer|easter|spring|winter)\b/i)?.[0];
 const name=/\bbank\s+holiday\b/i.test(t)?month[0].toUpperCase()+month.slice(1)+' Bank Holiday':season?season+' sale':'Shopify sale';
 const shopify_window=validateShopifySaleWindow({name,start_date:start,end_date:end,timezone:'Europe/London',product_limit:count,pos_population:'all_recorded'});
 return {source_policy:'shopify-native-sale-v1',shopify_window,years:[...new Set([Number(start.slice(0,4)),Number(end.slice(0,4))])],channels:['online','instore','unknown'],products:/\bproducts?\b/i.test(t)};
}
