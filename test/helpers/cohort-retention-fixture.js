// Warehouse-shaped aggregates from a hand-counted cohort fixture:
// 2025-01-01 A: four first observed Woo UK customers. All mature at 180 days.
// Two repeat at days 10 and 30; one at day 120; one never returns.
// 2025-11-01 A: one entry, immature at 90/180 days at the Dec 31 cutoff.
// B: two mature customers; one returns on day 60. Overlapping entry cohorts
// are possible, but distinct customers are counted once per collaboration.
export const cohortRows=[
  {source_platform:'woo',source_store:'ww',collaboration_name:'A',window_days:90,cohort_customers:5,mature_customers:4,repeat_customers:2,median_days_to_second:20},
  {source_platform:'woo',source_store:'ww',collaboration_name:'A',window_days:180,cohort_customers:5,mature_customers:4,repeat_customers:3,median_days_to_second:30},
  {source_platform:'woo',source_store:'ww',collaboration_name:'B',window_days:90,cohort_customers:2,mature_customers:2,repeat_customers:1,median_days_to_second:60},
  {source_platform:'woo',source_store:'ww',collaboration_name:'B',window_days:180,cohort_customers:2,mature_customers:2,repeat_customers:1,median_days_to_second:60},
  {source_platform:'shopify',source_store:'shopify',collaboration_name:'A',window_days:90,cohort_customers:1,mature_customers:0,repeat_customers:0,median_days_to_second:null},
  {source_platform:'shopify',source_store:'shopify',collaboration_name:'A',window_days:180,cohort_customers:1,mature_customers:0,repeat_customers:0,median_days_to_second:null}
].map(r=>({...r,observation_coverage_status:'verified_continuous',verified_coverage_start:'2020-01-01',verified_coverage_end:'2026-10-19',coverage_evidence:'fixture:hand-counted',observed_repeat_customers:r.repeat_customers}));
export const fixtureObservationCertificates=[['woo','ww'],['woo','usd'],['shopify','shopify']].map(([source_platform,source_store])=>({source_platform,source_store,time_zone:'Europe/London',status:'verified_continuous',start:'2020-01-01',end:'2026-10-19',evidence:'fixture:hand-counted'}));
