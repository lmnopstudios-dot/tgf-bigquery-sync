const MAX_GROUPS=12,MAX_ITEMS=10,DATE=/^\d{4}-\d{2}-\d{2}$/;
const number=value=>{const n=Number(value);return Number.isFinite(n)&&n>=0?n:null};
const text=(value,max=120)=>typeof value==='string'&&value.trim()&&value.length<=max?value.trim():null;
const period=value=>value&&DATE.test(value.start_date)&&DATE.test(value.end_date)&&value.start_date<=value.end_date;

/** Build an inert, bounded chart DTO only from recognized governed tool results. */
export function buildOracleInlineChart(tool,result){
  if(!result||typeof result!=='object')return null;
  if(tool==='get_shopify_online_country_products')return countries(result);
  if(tool==='analyze_customer_journey')return secondOrders(result);
  return null;
}

function countries(result){
  if(!period(result.period)||!Array.isArray(result.rows)||!result.rows.length)return null;
  const currencies=new Map();
  for(const row of result.rows.slice(0,1000)){
    const currency=typeof row?.currency==='string'?row.currency.toUpperCase():'';
    const rank=Number(row?.country_rank),value=number(row?.country_operational_net_sales),label=text(row?.country_name)||text(row?.country_code,3);
    if(!['GBP','USD'].includes(currency)||!Number.isInteger(rank)||rank<1||rank>MAX_ITEMS||value===null||!label)continue;
    const group=currencies.get(currency)||new Map();
    // Product rows repeat their parent country; retain one order-valued fact.
    if(!group.has(rank))group.set(rank,{label,value,rank});
    currencies.set(currency,group);
  }
  const groups=[...currencies].sort(([a],[b])=>a.localeCompare(b)).map(([currency,items])=>({label:currency,currency,items:[...items.values()].sort((a,b)=>a.rank-b.rank)})).filter(x=>x.items.length);
  if(!groups.length)return null;
  // Unknown geography remains coverage, not a fabricated ranked country.
  const coverage=groups.map(group=>{const row=result.rows.find(x=>String(x?.currency).toUpperCase()===group.currency),orders=number(row?.unknown_country_orders),sales=number(row?.unknown_country_sales);return orders===null||sales===null?null:{currency:group.currency,unknown_country_orders:orders,unknown_country_sales:sales}}).filter(Boolean);
  return {version:1,kind:'horizontal_bar',id:'shopify-online-shipping-countries',title:'Top Shopify Online Store shipping countries',period:`${result.period.start_date} to ${result.period.end_date}`,metric:'Operational net sales',source:'Shopify · direct shipping country',groups:groups.slice(0,MAX_GROUPS),coverage};
}

function secondOrders(result){
  const scope=result.scope;
  if(!scope||scope.group_by!=='cohort_year_downstream_product'||scope.exact_order_sequence!==2||!DATE.test(scope.cohort_entry_start||'')||!DATE.test(scope.cohort_entry_end||'')||!DATE.test(scope.observation_end||'')||!Array.isArray(result.results)||!result.results.length)return null;
  const years=new Map();
  for(const row of result.results.slice(0,1200)){
    const year=Number(row?.cohort_year),rank=Number(row?.rank),value=number(row?.returning_customers),label=text(row?.product);
    if(!Number.isInteger(year)||year<2000||year>2100||!Number.isInteger(rank)||rank<1||rank>MAX_ITEMS||value===null||!label)continue;
    const group=years.get(year)||new Map();if(!group.has(rank))group.set(rank,{label,value,rank});years.set(year,group);
  }
  const groups=[...years].sort(([a],[b])=>a-b).slice(0,MAX_GROUPS).map(([year,items])=>({label:`First-order cohort ${year}`,cohort_year:year,items:[...items.values()].sort((a,b)=>a.rank-b.rank)})).filter(x=>x.items.length);
  if(!groups.length)return null;
  return {version:1,kind:'horizontal_bar',id:'second-order-products-by-cohort-year',title:'Second-order product rankings by first-order cohort year',period:`${scope.cohort_entry_start} to ${scope.cohort_entry_end}; observed through ${scope.observation_end}`,metric:'Distinct customers',source:'Governed customer journey · exact second order',groups,coverage:[]};
}
