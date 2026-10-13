import { loadBigQueryConfig } from '../bigquery/client.js';

/** Non-secret bindings only. ShopifyQL is a different source and population. */
export function orderValueSourceBindings({project,env=process.env}) {
  const diagnosticProject=loadBigQueryConfig(env).project;
  const serverProject=env.GOOGLE_PROJECT_ID??'gf-full-data'; // server.js injected project
  return {
    order_values:{project,dataset:'shopify_data',date_field:'order_locations.created_at',time_zone:'Europe/London',channel:'retail_location_id IS NULL'},
    online_country_sales:{project:serverProject,dataset:'shopify_data',date_field:'order_financials.created_at',time_zone:'UTC (BigQuery DATE(TIMESTAMP) default)',channel:'retail_location_id IS NULL'},
    shopify_sales_kpis:{source:'ShopifyQL FROM sales',project:null,dataset:null,configured_shop:env.SHOPIFY_SHOP||null,date_field:'ShopifyQL sales calendar day',time_zone:'shop.ianaTimezone from Shopify metadata',channel:'Online Store',currency_basis:'shop currency; order values use presentment currency'},
    diagnostic_project:diagnosticProject,server_project:serverProject,
    project_bindings_consistent:project===serverProject&&project===diagnosticProject,
    interpretation:'Source bindings and date/channel semantics only. Previously working sales reports do not verify order-component coverage or equivalent populations.'
  };
}
