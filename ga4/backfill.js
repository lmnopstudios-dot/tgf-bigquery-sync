#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { BigQuery } from '@google-cloud/bigquery';
import { loadConfig } from '../diagnostics/ga4-access.js';
import { assertDate, previousDate } from './semantic.js';
import { backfillChunks, syncGa4 } from './sync.js';

export function parseBackfillArgs(argv) {
  const value = flag => { const index = argv.indexOf(flag); return index < 0 ? null : argv[index + 1]; };
  const startDate = value('--start'); const endDate = value('--end');
  if (!startDate || !endDate) throw new Error('--start and --end are required; never infer the platform launch boundary');
  assertDate(startDate, 'start'); assertDate(endDate, 'end');
  const chunkDays = Number(value('--chunk-days') || 31); const maxChunks = Number(value('--max-chunks') || 3); const resumeAfter = value('--resume-after');
  if (!Number.isInteger(chunkDays) || chunkDays < 1 || chunkDays > 31) throw new Error('--chunk-days must be between 1 and 31');
  if (!Number.isInteger(maxChunks) || maxChunks < 1 || maxChunks > 12) throw new Error('--max-chunks must be between 1 and 12');
  if (resumeAfter) assertDate(resumeAfter, 'resume-after');
  const unknown = argv.filter((arg, index) => arg.startsWith('--') && !['--start','--end','--chunk-days','--max-chunks','--resume-after','--dataset'].includes(arg));
  if (unknown.length) throw new Error(`Unknown argument: ${unknown[0]}`);
  return { startDate, endDate, chunkDays, maxChunks, resumeAfter, dataset: value('--dataset') || 'ga4' };
}

export function plannedChunks(options) {
  const effectiveStart = options.resumeAfter ? nextDate(options.resumeAfter) : options.startDate;
  if (effectiveStart > options.endDate) return [];
  return backfillChunks(effectiveStart, options.endDate, options.chunkDays).slice(0, options.maxChunks);
}
function nextDate(date) { const day = new Date(`${date}T00:00:00Z`); day.setUTCDate(day.getUTCDate() + 1); return day.toISOString().slice(0, 10); }

export async function runBackfill({ options, sync }) {
  const chunks = plannedChunks(options); const completed = []; const processedWithIncompleteCoverage=[];
  for (const chunk of chunks) {
    try { const result=await sync(chunk); completed.push(chunk); if(result?.fully_reportable===false||result?.processing_status==='processed_with_incomplete_coverage')processedWithIncompleteCoverage.push({ ...chunk, incomplete_days: result.incomplete_days || [] }); }
    catch (cause) {
      const resumeAfter = completed.at(-1)?.endDate || options.resumeAfter || previousDate(options.startDate);
      const status = { failed_chunk: chunk, committed_chunks: completed, earlier_chunks_committed: completed.length > 0, resume_after: resumeAfter, next_command: `npm run backfill:ga4 -- --start ${options.startDate} --end ${options.endDate} --resume-after ${resumeAfter} --chunk-days ${options.chunkDays} --max-chunks ${options.maxChunks}` };
      throw new BackfillChunkError(cause, status);
    }
  }
  const resumeAfter = completed.at(-1)?.endDate || options.resumeAfter || previousDate(options.startDate);
  return { requested: { start_date: options.startDate, end_date: options.endDate }, completed, processed_with_incomplete_coverage: processedWithIncompleteCoverage, fully_reportable: processedWithIncompleteCoverage.length===0, resume_after: resumeAfter, complete: resumeAfter >= options.endDate,
    next_command: resumeAfter >= options.endDate ? null : `npm run backfill:ga4 -- --start ${options.startDate} --end ${options.endDate} --resume-after ${resumeAfter} --chunk-days ${options.chunkDays} --max-chunks ${options.maxChunks}` };
}
export class BackfillChunkError extends Error {
  constructor(cause, status) { super(`GA4 backfill chunk failed atomically: ${cause?.message || cause}`); this.name = 'BackfillChunkError'; this.cause = cause; this.status = status; }
}

async function main() {
  const options = parseBackfillArgs(process.argv.slice(2)); const { propertyId, credentials } = loadConfig();
  const project = process.env.GOOGLE_PROJECT_ID || credentials.project_id; const { BetaAnalyticsDataClient } = await import('@google-analytics/data');
  const bigquery = new BigQuery({ projectId: project, credentials }); const client = new BetaAnalyticsDataClient({ credentials });
  const result = await runBackfill({ options, sync: chunk => syncGa4({ ...chunk, maxDays: options.chunkDays, maxRows: 100000, dataset: options.dataset, project, propertyId, bigquery, client }) });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch(error => { console.error(JSON.stringify({ error: error.message, ...(error.status || {}) }, null, 2)); process.exitCode = 1; });
