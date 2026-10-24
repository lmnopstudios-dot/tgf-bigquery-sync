// Non-sensitive diagnostic envelope. Never serialize rows, requests, SQL,
// credentials, arbitrary messages or response bodies.
const contexts=new WeakMap();
const stages=new Set(['fetch','transform','promotion_setup','staging_create','staging_insert','promotion']);
const tables=new Set(['order_locations','order_financials','order_refunds']);
const reasons=new Set(['invalid','invalidQuery','stopped','notFound','accessDenied','backendError','internalError','duplicate','quotaExceeded','rateLimitExceeded','resourcesExceeded','timeout','tableUnavailable']);
const fields=["cancelled_at","created_at","has_successful_refund_transaction","note","order_adjustments_json","order_id","order_name","order_source","original_discounts_presentment","original_discounts_shop","original_shipping_presentment","original_shipping_shop","original_subtotal_presentment","original_subtotal_shop","original_tax_presentment","original_tax_shop","original_total_presentment","original_total_shop","payment_gateway_names_json","presentment_currency","processed_at","refund_adjustment_tax_presentment","refund_adjustment_tax_shop","refund_created_at","refund_id","refund_line_items_json","refund_line_subtotal_presentment","refund_line_subtotal_shop","refund_line_tax_presentment","refund_line_tax_shop","refund_processed_at","refund_shipping_lines_json","refund_shipping_subtotal_presentment","refund_shipping_subtotal_shop","refund_shipping_tax_presentment","refund_shipping_tax_shop","refund_tax_presentment","refund_tax_shop","refund_total_presentment","refund_total_shop","refund_updated_at","retail_location_id","retail_location_name","shop_currency","source_app_id","successful_transaction_presentment","successful_transaction_shop","synced_at","total_received_presentment","total_received_shop","total_refunded_presentment","total_refunded_shop","transactions_json","updated_at"];
export function rememberFinanceFailure(error,context){if(error&&typeof error==='object'&&!contexts.has(error))contexts.set(error,context);return error;}
export function financeFailure(error,context=contexts.get(error)||{}){
  const out={version:1,kind:'finance_refresh_failure',stage:stages.has(context.stage)?context.stage:'unknown',error_name:['PartialFailureError','ApiError','Error'].includes(error?.name)?error.name:'UnknownError'};
  if(tables.has(context.table))out.table=context.table;
  if(Number.isSafeInteger(context.batch_index)&&context.batch_index>=0)out.batch_index=context.batch_index;
  if(typeof context.run_id==='string'&&/^[a-f0-9-]{36}$/i.test(context.run_id))out.run_id=context.run_id;
  const code=Number(error?.code);if(Number.isInteger(code)&&code>=400&&code<=599)out.http_status=code;
  const jobId=error?.job?.id||error?.response?.jobReference?.jobId;
  if(typeof jobId==='string'&&/^[A-Za-z0-9_-]{1,120}$/.test(jobId))out.warehouse_job_id=jobId;
  const outer=Array.isArray(error?.errors)&&error.errors.length?error.errors:Array.isArray(error?.response?.insertErrors)?error.response.insertErrors:[];
  out.error_entries=outer.length;out.sample_truncated=outer.length>20;
  const samples=[error];for(const item of outer.slice(0,20)){
    if(Array.isArray(item?.errors)){samples.push(...item.errors.slice(0,5));if(item.errors.length>5)out.sample_truncated=true;}
    else samples.push(item);
  }
  const rs=new Set(),categories=new Set(),columns=new Set();
  for(const sample of samples){
    if(reasons.has(sample?.reason))rs.add(sample.reason);
    const message=typeof sample?.message==='string'?sample.message.slice(0,4096):'';
    if(/missing configuration|must be|unknown argument|no successful watermark/i.test(message))categories.add('configuration_or_arguments');
    if(/pagination|orders connection|duplicate or missing Shopify order identity/i.test(message))categories.add('source_response');
    if(/streaming buffer/i.test(message))categories.add('streaming_buffer');
    if(/timestamp|datetime|date value/i.test(message))categories.add('date_time');
    if(/numeric|decimal|float|integer/i.test(message))categories.add('numeric');
    if(/no such field|unrecognized name|unknown field|not found inside/i.test(message))categories.add('schema_field');
    if(/required field|missing required/i.test(message))categories.add('required_field');
    if(/no matching signature|cannot coerce|type mismatch|invalid value/i.test(message))categories.add('type_or_value');
    for(const field of fields)if(new RegExp('\\b'+field+'\\b','i').test(message))columns.add(field);
  }
  out.reasons=[...rs].slice(0,4);out.categories=[...categories].slice(0,4);out.fields=[...columns].slice(0,4);
  if(rs.size>4||categories.size>4||columns.size>4)out.sample_truncated=true;
  if(!out.reasons.length&&!out.categories.length)out.detail='unclassified_failure';
  return out;
}
export function financeFailureJson(error,context){return JSON.stringify(financeFailure(error,context));}
