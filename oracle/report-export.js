import ExcelJS from 'exceljs';

const safe = value => String(value ?? '').replace(/[\r\n,]+/g, ' ').trim();
export function reportCsv(rows) {
  const columns = [...new Set(rows.flatMap(Object.keys))];
  const cell = value => `"${safe(value).replaceAll('"', '""')}"`;
  return `${columns.map(cell).join(',')}\n${rows.map(row => columns.map(key => cell(row[key])).join(',')).join('\n')}\n`;
}

export async function reportWorkbook(report) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'The Great Frog Oracle'; workbook.created = new Date(report.generated_at);
  const sheets = [['Summary', report.kpis], ['Sales', report.trend], ['Products', report.products], ['Context', report.context]];
  for (const [name, rows] of sheets) {
    if (!rows?.length) continue;
    const sheet = workbook.addWorksheet(name);
    const keys = [...new Set(rows.flatMap(Object.keys))];
    sheet.columns = keys.map(key => ({ header: key, key, width: 22 }));
    rows.forEach(row => sheet.addRow(row)); sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: 'frozen', ySplit: 1 }]; sheet.autoFilter = { from: 'A1', to: sheet.getRow(1).getCell(keys.length).address };
  }
  const definitions = workbook.addWorksheet('Definitions');
  definitions.addRows([['generated_at', report.generated_at], ['reporting_period', `${report.period.start_date} to ${report.period.end_date}`], ['comparison_period', `${report.comparison.start_date} to ${report.comparison.end_date}`], ['currency_policy', 'Currencies are separate; no FX conversion.'], ['limitations', (report.limitations || []).join(' | ')]]);
  return workbook.xlsx.writeBuffer();
}

function esc(value) { return String(value).replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)'); }
export function reportPdf(report) {
  const lines = ['THE GREAT FROG — ECOMMERCE REPORT', `${report.period.start_date} to ${report.period.end_date}`, `Comparison: ${report.comparison.start_date} to ${report.comparison.end_date}`, '', ...report.kpis.slice(0, 8).map(k => `${k.label}: ${k.value ?? 'Unavailable'} ${k.currency || ''}`), '', 'Data notes', ...(report.limitations || []).slice(0, 6)];
  let stream = 'BT /F1 11 Tf 44 790 Td 15 TL ' + lines.map((l, i) => `${i ? 'T* ' : ''}(${esc(l).slice(0, 105)}) Tj`).join(' ') + ' ET\n';
  // A simple governed-data trend visual is drawn into the PDF rather than only listing values.
  const values = report.trend.map(r => Number(r.net_gross)).filter(Number.isFinite); const max = Math.max(...values, 1);
  stream += report.trend.slice(0, 45).map((r, i) => `${44 + i * 10} 250 ${Math.max(1, Number(r.net_gross) / max * 160)} 6 re f`).join('\n');
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let pdf='%PDF-1.4\n', offsets=[0]; objects.forEach((o,i)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${o}\nendobj\n`}); const xref=Buffer.byteLength(pdf); pdf+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(x=>String(x).padStart(10,'0')+' 00000 n ').join('\n')}\ntrailer << /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}
