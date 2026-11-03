// Shared by the reporting factory and the narrow channel diagnostic. Native
// order/location IDs are compared exactly; only payment codes are normalized.
const nonblank=expression=>`IF(NULLIF(TRIM(${expression}),'') IS NULL,NULL,${expression})`;
const code=expression=>`NULLIF(UPPER(TRIM(${expression})),'')`;
export function squarePaymentChannelEvidenceSql(project){
 if(!/^[A-Za-z0-9_-]+$/.test(project))throw Error('Invalid project');
 return `WITH raw_payments AS(SELECT TO_JSON(p,stringify_wide_numbers=>TRUE) j FROM \`${project}.square_data.payments\` p),
 fields AS(SELECT ${nonblank("JSON_VALUE(j,'$.order_id')")} oid,${nonblank("JSON_VALUE(j,'$.location_id')")} location_id,
 ${code("JSON_VALUE(j,'$.status')")} status,${code("JSON_VALUE(j,'$.source_type')")} source_type,
 ${code("JSON_VALUE(j,'$.card_details_entry_method')")} flat_entry_method,
 ${code("COALESCE(JSON_VALUE(j,'$.card_details.entry_method'),JSON_VALUE(SAFE.PARSE_JSON(JSON_VALUE(j,'$.card_details')),'$.entry_method'))")} nested_entry_method FROM raw_payments)
 SELECT *,COALESCE(flat_entry_method,nested_entry_method) entry_method,
 COALESCE(flat_entry_method IS NOT NULL AND nested_entry_method IS NOT NULL AND flat_entry_method!=nested_entry_method,FALSE) entry_method_conflict
 FROM fields`;
}
export function squareOrderChannelsSql(){
 return `WITH counts AS(SELECT o.oid,o.location_id order_location,
 COUNT(p.oid) payment_rows,COUNTIF(p.status='COMPLETED') completed_payments,
 COUNTIF(p.status='COMPLETED' AND p.source_type='CARD' AND p.entry_method IN ('EMV','SWIPED','CONTACTLESS') AND NOT p.entry_method_conflict) card_present_payments,
 COUNTIF(p.oid IS NOT NULL AND (p.status IS NULL OR p.status!='COMPLETED')) ignored_noncompleted_payments,
 COUNTIF(p.status='COMPLETED' AND p.location_id IS NULL) missing_payment_location,
 COUNTIF(p.status='COMPLETED' AND p.location_id IS NOT NULL AND p.location_id!=o.location_id) conflicting_payment_location,
 COUNTIF(p.status='COMPLETED' AND p.entry_method_conflict) conflicting_entry_method,
 COUNTIF(p.status='COMPLETED' AND p.source_type IS NULL) missing_payment_type,
 COUNTIF(p.status='COMPLETED' AND p.source_type IS NOT NULL AND p.source_type!='CARD') noncard_completed_payments,
 COUNTIF(p.status='COMPLETED' AND p.source_type='CARD' AND p.entry_method IS NULL) missing_entry_method,
 COUNTIF(p.status='COMPLETED' AND p.source_type='CARD' AND p.entry_method IS NOT NULL AND p.entry_method NOT IN ('EMV','SWIPED','CONTACTLESS')) nonpresent_completed_payments
 FROM sx_square o LEFT JOIN sx_channel_evidence p USING(oid) GROUP BY o.oid,o.location_id),
 reasons AS(SELECT *,CASE
 WHEN payment_rows=0 THEN 'no_exact_payment_join'
 WHEN completed_payments=0 THEN 'no_completed_payment'
 WHEN NULLIF(TRIM(order_location),'') IS NULL THEN 'missing_order_location'
 WHEN missing_payment_location>0 THEN 'missing_payment_location'
 WHEN conflicting_payment_location>0 THEN 'conflicting_payment_location'
 WHEN conflicting_entry_method>0 THEN 'conflicting_entry_method'
 WHEN missing_payment_type>0 THEN 'missing_payment_type'
 WHEN noncard_completed_payments>0 THEN 'noncard_or_mixed_completed_tender'
 WHEN missing_entry_method>0 THEN 'missing_entry_method'
 WHEN nonpresent_completed_payments>0 THEN 'nonpresent_or_unsupported_entry_method'
 WHEN completed_payments=card_present_payments THEN 'completed_card_present_at_order_location'
 ELSE 'insufficient_payment_evidence' END channel_reason FROM counts)
 SELECT *,IF(channel_reason='completed_card_present_at_order_location','In-store','Unknown') channel FROM reasons`;
}
