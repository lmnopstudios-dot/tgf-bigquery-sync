/** Deployed read contract, excluding customer names and other private columns. */
export const ORDER_VALUE_SCHEMA=Object.freeze({
  order_locations:{order_id:'STRING',created_at:'TIMESTAMP',updated_at:'TIMESTAMP',synced_at:'TIMESTAMP',retail_location_id:'STRING',source_app_id:'STRING'},
  order_financials:{order_id:'STRING',created_at:'TIMESTAMP',updated_at:'TIMESTAMP',synced_at:'TIMESTAMP',cancelled_at:'TIMESTAMP',presentment_currency:'STRING',original_subtotal_presentment:'NUMERIC',original_total_presentment:'NUMERIC',original_shipping_presentment:'NUMERIC'},
  order_customers:{order_id:'STRING',order_created_at:'TIMESTAMP',synced_at:'TIMESTAMP',cancelled_at:'TIMESTAMP',display_financial_status:'STRING'},
  order_shipping_geography:{order_id:'STRING',order_created_at:'TIMESTAMP',synced_at:'TIMESTAMP',geography_status:'STRING',shipping_country_code:'STRING'}
});
export function inspectOrderValueSchema(rows){
  const missing=[],incompatible=[];
  for(const [table,columns] of Object.entries(ORDER_VALUE_SCHEMA))for(const [column,type] of Object.entries(columns)){
    const found=rows.find(r=>r.table_name===table&&r.column_name===column);
    if(!found)missing.push({table,column,required_type:type});
    else if(found.data_type!==type)incompatible.push({table,column,required_type:type,actual_type:found.data_type});
  }
  return {valid:!missing.length&&!incompatible.length,missing,incompatible};
}
