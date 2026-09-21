const DAY = 86400000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function date(value, field) {
  if (!ISO_DATE.test(String(value))) throw new Error(`${field} must use YYYY-MM-DD`);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(+parsed) || parsed.toISOString().slice(0, 10) !== value) throw new Error(`${field} is not a valid date`);
  return parsed;
}
const iso = value => value.toISOString().slice(0, 10);

export function reportPeriod(input, today = new Date()) {
  const completeDay = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 1));
  const defaultStart = new Date(+completeDay - 29 * DAY);
  const start = date(input.start_date || iso(defaultStart), 'start_date');
  const end = date(input.end_date || iso(completeDay), 'end_date');
  if (start > end) throw new Error('start_date must be on or before end_date');
  const days = Math.round((end - start) / DAY) + 1;
  if (days > 1096) throw new Error('report period cannot exceed 1096 days');
  const mode = input.comparison || 'previous_year';
  if (!['previous_period', 'previous_year', 'custom'].includes(mode)) throw new Error('comparison must be previous_period, previous_year, or custom');
  let comparisonStart, comparisonEnd;
  if (mode === 'previous_period') {
    comparisonEnd = new Date(+start - DAY); comparisonStart = new Date(+comparisonEnd - (days - 1) * DAY);
  } else if (mode === 'previous_year') {
    comparisonStart = new Date(start); comparisonEnd = new Date(end);
    comparisonStart.setUTCFullYear(start.getUTCFullYear() - 1); comparisonEnd.setUTCFullYear(end.getUTCFullYear() - 1);
  } else {
    comparisonStart = date(input.comparison_start, 'comparison_start');
    comparisonEnd = date(input.comparison_end, 'comparison_end');
    if (comparisonStart > comparisonEnd) throw new Error('comparison_start must be on or before comparison_end');
  }
  return { current: { start_date: iso(start), end_date: iso(end), days }, comparison: { mode, start_date: iso(comparisonStart), end_date: iso(comparisonEnd) } };
}

