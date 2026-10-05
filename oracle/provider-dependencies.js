import {createBigQueryClient} from '../bigquery/client.js';
import {ga4Dataset} from '../ga4/storage-contract.js';
import {createDeviceSourceConversionService} from './device-source-conversion.js';

/** One production contract for CLI, HTTP, interactive and durable Oracle paths. */
export function createOracleProviderDependencies({env=process.env,bigquery=null,project=null,dataset=null,dryRun=false}={}){
  const client=bigquery&&project?{bigquery,project}:createBigQueryClient(env);
  const conversionDataset=dataset||ga4Dataset(env.GA4_DATASET);
  return Object.freeze({...client,conversionDataset,deviceConversion:createDeviceSourceConversionService({...client,dataset:conversionDataset,dryRun})});
}
