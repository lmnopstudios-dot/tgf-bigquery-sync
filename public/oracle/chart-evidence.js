/** Keep source and currency populations separate; null points break a line. */
export function trendSeries(rows, metadata = {}) {
  const groups = new Map();
  for (const row of rows) {
    const label = [metadata.series && row[metadata.series], row.currency,
      row.source_platform || row.source, row.source_store, row.channel].filter(Boolean).join(' · ') || 'Evidence';
    const group = groups.get(label) || [];
    const raw = row[metadata.metric];
    group.push({row, value: raw == null || raw === '' || typeof raw === 'boolean' || !Number.isFinite(Number(raw)) ? null : Number(raw)});
    groups.set(label, group);
  }
  return [...groups].map(([label, points]) => ({label, points}));
}
