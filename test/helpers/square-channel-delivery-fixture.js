import {readFileSync} from 'node:fs';
import {acceptanceFixture} from './oracle-acceptance.js';
const result=JSON.parse(readFileSync(new URL('../fixtures/square-channel-results.json',import.meta.url),'utf8'));
export const SQUARE_CHANNEL_QUESTION='Show the most popular second-purchase products. First-observed purchase dates: 2024-01-01 through 2024-01-02. Observation cutoff: 2026-10-19. Include Square. Entry channel: in-store. Follow-up channel: all channels. Next purchase anywhere then filter.';
export const SQUARE_COLLAB_QUESTION='What products did customers buy next after their first collaboration purchase? First-observed purchase dates: 2024-01-01 through 2024-01-02. Observation cutoff: 2026-10-19. Include Square. Entry channel: in-store. Follow-up channel: all channels.';
export const SQUARE_RETENTION_QUESTION='Show collaboration retention from 2024-01-01 to 2024-01-02. Observation cutoff: 2026-10-19. Include Square. Entry channel: in-store. Follow-up channel: all channels.';
export function squareChannelDeliveryFixture({active=true}={}){
 const f=acceptanceFixture({retention_combined:true,identityEnv:{ORACLE_CUSTOMER_IDENTITY_MODE:'email_candidate_v2',ORACLE_CUSTOMER_IDENTITY_DATASET:'identity',ORACLE_CUSTOMER_IDENTITY_SNAPSHOT:'fixture',...(active?{ORACLE_SQUARE_REPORTING_VERSION:'square_channels_v1',ORACLE_SQUARE_REPORTING_EXTENSION_ID:'review-fixture'}:{})},journeyRows:(query,state)=>{
  const group=query.query.includes('collaboration_journeys')?'retention_collaboration_journeys':query.query.includes('product_journeys')?'retention_product_journeys':'retention_windows';
  if(state.square_fail)throw Object.assign(Error('synthetic failure'),{code:'FIXTURE_READ_FAILED'});
  const key=query.params.entry_channel==='Online'?(state.square_next_matching?'online_instore_matching':'online_instore_any'):'instore_any';
  const rows=structuredClone(result.cases[key][group]);
  if(state.square_corrupt&&group==='retention_collaboration_journeys')rows[0].collaboration_journeys.find(r=>r.cohort_type===state.square_corrupt).products[0].denominator_customers=999;
  return rows;
 }});
 return f;
}
