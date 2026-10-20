// Shared evidence contract, deliberately independent of transaction eligibility.
// Repository collectors establish provenance fields, not a certified identity graph.
export const CUSTOMER_HISTORY = Object.freeze({
  version: 1,
  identity: 'source_qualified_only',
  migration_linkage: 'not_verified',
  migration_evidence: 'persisted_app_dates_and_line_attributes_require_audit',
  imported_records: 'identity_history_evidence_only_when_verified',
  transactions: 'original_woo_once_shopify_matrixify_excluded',
  prior_history: 'unverified',
  follow_up: 'unverified',
  classification: 'independently_governed',
  first_ever: false,
  company_wide_ranking: false,
});
export function customerHistoryContract(active=false) { return {...CUSTOMER_HISTORY,...(active?{identity:'email_candidate_v1',migration_linkage:'analytical_email_candidate'}:{})}; }
export const HISTORY_LIMITATION = 'Woo WW, Woo USD and Shopify retain source-qualified identities. Persisted migration provenance may support identity/history lookup after verification; a deterministic customer bridge has not been verified. Matrixify copies remain excluded from transaction populations. Customer linkage, original-date/product provenance, prior history, follow-up collection and classification coverage require separate verification.';
// Saved results may omit the new metadata, but cannot assert unsupported links.
export function validCustomerHistoryContract(value) {
  return value!=null&&Object.keys(value).length===Object.keys(CUSTOMER_HISTORY).length
    &&[customerHistoryContract(),customerHistoryContract(true)].some(contract=>Object.entries(contract).every(([key,expected])=>value[key]===expected));
}
