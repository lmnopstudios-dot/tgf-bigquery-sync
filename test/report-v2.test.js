import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { reportPeriod } from '../oracle/report-period.js';
import { reportCsv, reportPdf, reportWorkbook } from '../oracle/report-export.js';
import { createEcommerceReportV2 } from '../oracle/ecommerce-report-v2.js';

test('report periods default to complete days and validate bounded custom comparisons', () => {
  const period = reportPeriod({}, new Date('2026-09-21T18:00:00Z'));
  assert.deepEqual(period.current, { start_date: '2026-08-22', end_date: '2026-09-20', days: 30 });
  assert.equal(period.comparison.start_date, '2025-08-22');
  assert.throws(() => reportPeriod({ start_date:'2020-01-01', end_date:'2026-01-01' }), /1096/);
  assert.throws(() => reportPeriod({ start_date:'2026-01-01', end_date:'2026-01-02', comparison:'custom' }), /comparison_start/);
});

test('report finance query is parameterized, bounded, currency-separated and parallel', async () => {
  const calls=[]; const bigquery={query:async options=>{calls.push(options);return [[{date:'2026-01-01',currency:calls.length===1?'GBP':'GBP',net_gross:calls.length===1?100:50,gross_sales:110,refunds:-10,orders:2,channel:'Online'}]]}};
  const service=createEcommerceReportV2({bigquery,project:'test',knowledgeService:{}});
  const result=await service('overview',{start_date:'2026-01-01',end_date:'2026-01-31',comparison:'previous_period'});
  assert.equal(calls.length,2); assert.ok(calls.every(x=>x.params.start_date && x.maximumBytesBilled));
  assert.match(calls[0].query, /@start_date/); assert.doesNotMatch(calls[0].query,/2026-01-01/);
  assert.deepEqual(result.currencies,['GBP']); assert.equal(result.kpis[0].comparison_value,50);
  assert.match(result.limitations.join(' '), /never converted/);
});

test('missing sections are explicit unavailable states rather than zeroes', async () => {
  const service=createEcommerceReportV2({bigquery:{},project:'test',knowledgeService:{}});
  const products=await service('products',{start_date:'2026-01-01',end_date:'2026-01-02'});
  assert.equal(products.status,'unavailable'); assert.deepEqual(products.rows,[]); assert.match(products.limitations[0],/cross-source product identity/);
});

test('PDF, XLSX and CSV exports are real bounded formats with numeric cells', async () => {
  const report={generated_at:'2026-09-21T00:00:00Z',period:{start_date:'2026-09-01',end_date:'2026-09-20'},comparison:{start_date:'2025-09-01',end_date:'2025-09-20'},kpis:[{label:'Sales',value:12,currency:'GBP'}],trend:[{date:'2026-09-01',net_gross:12}],products:[],context:[],limitations:['Currencies separate.']};
  assert.match(reportPdf(report).subarray(0,8).toString(),/%PDF-1.4/); assert.match(reportCsv(report.trend),/"net_gross"/);
  const buffer=await reportWorkbook(report), workbook=new ExcelJS.Workbook(); await workbook.xlsx.load(buffer);
  assert.equal(workbook.getWorksheet('Sales').getCell('B2').value,12); assert.ok(workbook.getWorksheet('Definitions'));
});
