import { orderValuePopulationSql, ORDER_VALUE_FILTER_STAGES } from './order-value-provider.js';

const components=[
  ['locations','order_locations','created_at'],
  ['financials','order_financials','created_at'],
  ['customers','order_customers','order_created_at'],
  ['geography','order_shipping_geography','order_created_at']
];
/** Eight component aggregates plus fixed-size intersection/filter arrays. Never IDs or money. */
export function orderValueTraceSql(project) {
  const population=orderValuePopulationSql(project); // Also validates project and shares snapshots/predicates.
  const period=field=>`DATE(${field},'Europe/London') BETWEEN DATE(@start_date) AND DATE(@end_date)`;
  const metrics=(alias,table,field,snapshot)=>`SELECT '${table}' component,'${snapshot}' snapshot,'${field}' business_date_field,
    COUNT(*) row_count,COUNT(DISTINCT order_id) distinct_orders,
    COUNTIF(${field} IS NULL) null_business_dates,
    MIN(${field}) first_business_timestamp,MAX(${field}) last_business_timestamp,
    MIN(DATE(${field},'Europe/London')) first_business_date,MAX(DATE(${field},'Europe/London')) last_business_date,
    MIN(synced_at) first_collection,MAX(synced_at) latest_collection,COUNTIF(synced_at IS NULL) null_collection_timestamps,
    COUNTIF(${period(field)}) period_rows,
    COUNT(DISTINCT IF(${period(field)},order_id,NULL)) period_orders,
    COUNTIF(DATE(${field}) BETWEEN DATE(@start_date) AND DATE(@end_date)) utc_period_rows,
    COUNTIF(DATE(${field})!=DATE(${field},'Europe/London')) utc_london_date_differences
    FROM ${alias}`;
  const aggregates=components.flatMap(([alias,table,field])=>[
    metrics(`\`${project}.shopify_data.${table}\``,table,field,'raw'),metrics(alias,table,field,'latest')
  ]).join('\nUNION ALL\n');
  const allMasks=components.map(([alias],i)=>`SELECT order_id,${1<<i} component_bit FROM ${alias}`).join('\nUNION ALL\n');
  const masks=components.map(([alias,,field],i)=>`SELECT order_id,${1<<i} component_bit FROM ${alias} WHERE ${period(field)}`).join('\nUNION ALL\n');
  const combinations=[['locations_financials',3],['locations_status',5],['locations_geography',9],['financials_status',6],['financials_geography',10],['status_geography',12],['all_components',15]];
  const intersections=combinations.map(([name,mask])=>`STRUCT('${name}' intersection,COUNTIF((component_mask & ${mask})=${mask}) orders)`).join(',\n');
  const stages=[['date_scope','TRUE'],...ORDER_VALUE_FILTER_STAGES.map(([name],i)=>[name,ORDER_VALUE_FILTER_STAGES.slice(0,i+1).map(([,p])=>p).join(' AND ')])];
  const counts=stages.map(([name,predicate],i)=>`STRUCT(${i} stage_index,'${name}' stage,COUNTIF(${predicate}) surviving_orders,COUNTIF((${predicate}) IS NULL) unknown_predicate_orders)`).join(',\n');
  return `${population}, component_metrics AS (${aggregates}), period_presence AS (${masks}),
    presence AS (SELECT order_id,BIT_OR(component_bit) component_mask FROM period_presence GROUP BY order_id),
    all_presence_rows AS (${allMasks}),
    all_presence AS (SELECT order_id,BIT_OR(component_bit) component_mask FROM all_presence_rows GROUP BY order_id)
  SELECT ARRAY(SELECT AS STRUCT * FROM component_metrics ORDER BY component,snapshot) components,
    (SELECT COUNT(*) FROM presence) any_component_period_orders,
    (SELECT [${intersections}] FROM presence) period_intersections,
    (SELECT [${intersections}] FROM all_presence) all_snapshot_intersections,
    (SELECT [${intersections}] FROM all_presence WHERE order_id IN (SELECT order_id FROM presence)) period_candidate_intersections,
    (SELECT [${counts}] FROM scoped) filter_stages,
    (SELECT AS STRUCT COUNT(*) latest_location_orders,
      COUNTIF(order_date IS NULL) null_location_dates,
      COUNTIF(${period('location_created_at')}) location_period_orders,
      COUNTIF(${period('location_created_at')} AND financial_matched) location_period_financial_matches,
      COUNTIF(${period('location_created_at')} AND customer_matched) location_period_status_matches,
      COUNTIF(${period('location_created_at')} AND geography_matched) location_period_geography_matches,
      COUNTIF(${period('location_created_at')} AND financial_matched AND customer_matched AND geography_matched) location_period_all_component_matches,
      COUNTIF(financial_matched) financial_matches,COUNTIF(customer_matched) status_matches,COUNTIF(geography_matched) geography_matches,
      COUNTIF(financial_matched AND customer_matched AND geography_matched) all_component_matches,
      COUNTIF(financial_matched AND ${period('financial_created_at')}) financial_period_matches,
      COUNTIF(customer_matched AND ${period('status_created_at')}) status_period_matches,
      COUNTIF(geography_matched AND ${period('geography_created_at')}) geography_period_matches,
      COUNTIF(${period('financial_created_at')} AND (order_date IS NULL OR NOT (${period('location_created_at')}))) financial_period_outside_location_scope,
      COUNTIF(financial_created_at IS NOT NULL AND location_created_at IS NOT NULL AND financial_created_at!=location_created_at) financial_location_timestamp_disagreements
      FROM joined) join_and_date_scope,
    (SELECT COUNT(*) FROM (SELECT DISTINCT order_id FROM \`${project}.shopify_data.order_locations\` WHERE ${period('created_at')}
      EXCEPT DISTINCT SELECT order_id FROM locations WHERE ${period('created_at')})) location_period_orders_removed_by_snapshot
  LIMIT 1`;
}

/** Localizes observed loss; never equates component absence with absence of sales. */
export function assessOrderValueTrace(trace,period) {
  if(!trace?.components?.length)return {status:'unavailable',period};
  const latest=trace.components.filter(c=>c.snapshot==='latest');
  const absent=latest.filter(c=>Number(c.period_orders)===0).map(c=>({component:c.component,business_date_field:c.business_date_field,period,base_rows:Number(c.row_count),null_business_dates:Number(c.null_business_dates),first_business_date:c.first_business_date,last_business_date:c.last_business_date}));
  const location=latest.find(c=>c.component==='order_locations');
  let status='eligible_population_retrieved';
  if(!location||Number(location.period_orders)===0)status=Number(location?.row_count)===0?'location_component_empty':Number(trace.location_period_orders_removed_by_snapshot)>0?'location_snapshot_date_loss':Number(location?.null_business_dates)===Number(location?.row_count)?'location_business_dates_absent':'location_period_coverage_absent';
  else if(Number(trace.filter_stages?.at(-1)?.surviving_orders)===0){
    const firstZero=trace.filter_stages.find(s=>Number(s.surviving_orders)===0)?.stage;
    status=['financial_match','status_match','geography_match'].includes(firstZero)?'required_component_intersection_gap':'empty_after_eligibility_predicates';
  }
  const stages=trace.filter_stages||[];
  return {status,period,absent_period_components:absent,first_zero_stage:stages.find(s=>Number(s.surviving_orders)===0)?.stage||null,interpretation:'Counts refer to collected component snapshots and their own business dates, not September sales or authoritative population completeness.'};
}
