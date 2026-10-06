/** Missing or malformed evidence is not a supported zero. */
export const evidenceNumber = value => value == null || value === '' || typeof value === 'boolean'
  ? null : Number.isFinite(Number(value)) ? Number(value) : null;
export function evidenceSum(rows, field) {
  const values = rows.map(row => evidenceNumber(row[field]));
  return values.length && values.every(value => value !== null)
    ? values.reduce((total, value) => total + value, 0) : null;
}
