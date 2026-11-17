/** JSON objects are unordered in BigQuery. Worksheet headers own column order;
 * evidence arrays own row order. Neither hash checks nor row counts alone prove
 * that the saved cells still match the retained evidence. */
export function assertWorksheetEvidence(sheet, rows, failure = () => Error('WORKBOOK_EVIDENCE_MISMATCH'), normalise = value => value) {
  const expected = new Set(rows.flatMap(Object.keys));
  if (!sheet || sheet.rowCount !== rows.length + 1 || sheet.columnCount !== expected.size)
    throw failure('structure');
  const columns = Array.from({length: sheet.columnCount}, (_, i) => sheet.getCell(1, i + 1).value);
  if (columns.some(key => typeof key !== 'string' || !expected.has(key)) || new Set(columns).size !== columns.length)
    throw failure('columns');
  for (const [i, row] of rows.entries()) {
    for (const [j, key] of columns.entries()) {
      if (normalise(sheet.getCell(i + 2, j + 1).value ?? null, row, key) !== normalise(row[key] ?? null, row, key))
        throw failure('cells');
    }
  }
  return true;
}
