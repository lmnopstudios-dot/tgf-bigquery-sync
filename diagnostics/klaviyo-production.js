#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {createBigQueryClient} from '../bigquery/client.js';
import {createKlaviyoEmailService} from '../oracle/klaviyo-email.js';
import {requireGate,collectPilot} from '../klaviyo/sync.js';
import {createKlaviyoClient} from '../klaviyo/client.js';
import {parseMetricIds} from '../klaviyo/discovery.js';
const env=process.env,manifest=JSON.parse(await readFile(env.KLAVIYO_DISCOVERY_MANIFEST,'utf8')),metricIds=parseMetricIds(env.KLAVIYO_CONVERSION_METRIC_IDS);requireGate(manifest,{timezone:env.KLAVIYO_ACCOUNT_TIMEZONE,currency:env.KLAVIYO_ACCOUNT_CURRENCY,metricIds});const client=createKlaviyoClient({apiKey:env.KLAVIYO_PRIVATE_API_KEY,revision:env.KLAVIYO_API_REVISION,maxCalls:12,timeoutMs:15000});const rows=await collectPilot({client,manifest,revision:env.KLAVIYO_API_REVISION,timezone:env.KLAVIYO_ACCOUNT_TIMEZONE,currency:env.KLAVIYO_ACCOUNT_CURRENCY,metricIds});const {bigquery,project}=createBigQueryClient(env),oracle=createKlaviyoEmailService({bigquery,project});const evidence=await oracle('get_klaviyo_email_performance',{start_date:'2026-08-01',end_date:'2026-08-31'});console.log(JSON.stringify({status:'read_only_diagnostic_passed',live:true,api_rows:rows.length,persisted_evidence_rows:evidence.rows.length,helpers:['collectPilot','createKlaviyoEmailService'],note:'No data was written.'},null,2));
