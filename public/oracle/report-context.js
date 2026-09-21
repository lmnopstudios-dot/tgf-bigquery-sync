export function reportOracleContext(data, section) {
  return {
    report: 'Ecommerce v2', report_section: section,
    current_period: { start_date: data.period.start_date, end_date: data.period.end_date },
    comparison_period: { start_date: data.comparison.start_date, end_date: data.comparison.end_date },
    comparison_type: data.comparison_type || data.comparison.mode || 'custom',
    selected_currencies: data.currencies || [],
    relevant_metric_identifiers: (data.kpis || []).map(item => item.metric),
    evidence_availability: data.evidence_availability || {}
  };
}
