import { createCustomerJourneyService } from './customer-journey.js';
import { createPopulationConversionProvider } from './population-conversion.js';
import { createBasketProvider } from './basket-provider.js';
import { createOrderValueProvider } from './order-value-provider.js';
import { fetchPublishedProducts } from './product-priority.js';
import { createPriorityShopifyTransport } from './product-priority-production.js';
import { createDailySalesProvider } from './daily-sales-provider.js';
import {createTikTokService} from './tiktok.js';
import {createMetaInstagramService} from './meta-instagram.js';
import { createKlaviyoEmailService } from './klaviyo-email.js';
import {createBigQueryClient} from '../bigquery/client.js';
import {ga4Dataset} from '../ga4/storage-contract.js';
import {createDeviceSourceConversionService} from './device-source-conversion.js';

/** One production contract for CLI, HTTP, interactive and durable Oracle paths. */
export function createOracleProviderDependencies({env=process.env,bigquery=null,project=null,dataset=null,dryRun=false,shopifySales=null,shopifyProductTransport=null,klaviyoFetch=null,shopifyCountryGraphql=null,shopifyCountryFetch=null,observationCertificates=[],now}={}){
  const client=bigquery&&project?{bigquery,project}:createBigQueryClient(env);
  const conversionDataset=dataset||ga4Dataset(env.GA4_DATASET);
  return Object.freeze({...client,conversionDataset,customerJourney:{analyzeCustomerJourney:(...args)=>createCustomerJourneyService({...client,observationCertificates,env}).analyzeCustomerJourney(...args)},populationConversion:createPopulationConversionProvider({env,graphql:shopifyCountryGraphql,fetchImpl:shopifyCountryFetch||fetch,...(now?{now}:{})}),orderValues:createOrderValueProvider(client),basketComposition:createBasketProvider(client),productPrices:options=>{let calls=0;const transport=shopifyProductTransport||createPriorityShopifyTransport({shop:env.SHOPIFY_SHOP,clientId:env.SHOPIFY_CLIENT_ID,clientSecret:env.SHOPIFY_CLIENT_SECRET});return fetchPublishedProducts((...args)=>{if(++calls>25)throw Object.assign(Error('Catalogue call bound'),{code:'CATALOGUE_READ_BOUND'});return transport(...args);},{...options,includeSeo:false,inspectClassification:false,destinationPrices:true,maxPages:7});},dailySales:createDailySalesProvider({shopifySales}),social:((meta,tiktok)=>(name,args)=>name==='get_tiktok_performance'?tiktok(name,args):meta(name,args))(createMetaInstagramService({...client,env}),createTikTokService(client)),klaviyo:createKlaviyoEmailService({...client,env,fetchImpl:klaviyoFetch||fetch}),deviceConversion:createDeviceSourceConversionService({...client,dataset:conversionDataset,dryRun})});

}
