/**
 * Read-only postcode-to-country feasibility study.
 * Postal values are held only long enough to classify and are never returned or logged.
 */
import { BigQuery } from '@google-cloud/bigquery';
import { pathToFileURL } from 'node:url';

export const CLASSIFIER_VERSION = 'postcode-syntax-v1';
export const TIER_A_MIN_PREDICTIONS = 100;
export const TIER_A_MIN_HOLDOUT = 30;
export const TIER_A_MIN_PRECISION = 0.999;
const WRITE_SQL = /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE|CALL|EXPORT|LOAD)\b/i;
const PII_KEYS = /(?:^|_)(?:postcode|postal|raw_json|name|email|phone|street|address|city)(?:_|$)/i;

export function assertReadOnly(sql) {
  if (!/^\s*(?:SELECT|WITH)\b/i.test(sql) || WRITE_SQL.test(sql)) throw new Error('Diagnostic refused non-read-only SQL');
}

export function normalizePostcode(value) {
  return String(value ?? '').toUpperCase().trim().replace(/[^A-Z0-9]/g, '');
}

// These rules are deliberately few. Each has a constrained national grammar rather
// than a generic length test. Crown Dependency outward areas are excluded from GB.
const GB = /^(?:GIR0AA|(?:[A-PR-UWYZ][0-9][0-9A-HJKPSTUW]?|[A-PR-UWYZ][A-HK-Y][0-9][0-9ABEHMNPRVWXY]?)[0-9][ABD-HJLNP-UW-Z]{2})$/;
const CA = /^[ABCEGHJ-NPRSTVXY][0-9][ABCEGHJ-NPRSTV-Z][0-9][ABCEGHJ-NPRSTV-Z][0-9]$/;
// Eircode routing keys are an official finite namespace; D6W is the sole exceptional key.
const IE_ROUTING = /^(?:A4[125]|A6[37]|A7[5W]|A8[123469]|C1[5W]|D(?:0[1-9]|1[0-8]|20|22|24|6W)|E(?:21|25|32|34|41|45|53|91)|F(?:12|23|26|28|31|35|42|45|52|56|91|92|93|94)|H(?:12|14|16|18|23|53|54|62|65|71|91)|K(?:32|34|36|45|56|67|78)|N(?:37|39|41|91)|P(?:12|14|17|24|25|31|32|36|43|47|51|56|61|67|72|75|81|85)|R(?:14|21|32|35|42|45|51|56|93|95)|T(?:12|23|34|45|56)|V(?:14|15|23|31|35|42|92|93|94|95)|W(?:12|23|34|91)|X(?:35|42|91)|Y(?:14|21|25|34|35))$/;

export const RULES = [
  { id: 'GB_UK_FULL', country: 'GB', rationale: 'Validated UK outward/inward structure; excludes JE, GY and IM outward areas and permits GIR 0AA.', test: p => GB.test(p) && !/^(?:JE|GY|IM)/.test(p) },
  { id: 'CA_FSA_LDU', country: 'CA', rationale: 'Canadian alternating letter-digit FSA/LDU grammar with the nationally disallowed letters excluded.', test: p => CA.test(p) },
  { id: 'IE_EIRCODE_ROUTING', country: 'IE', rationale: 'Eircode routing-key allowlist plus four-character unique identifier; not a generic alphanumeric rule.', test: p => p.length === 7 && IE_ROUTING.test(p.slice(0, 3)) && /^[A-Z0-9]{4}$/.test(p.slice(3)) }
];

export function classifyPostcode(value) {
  const normalized = normalizePostcode(value);
  const matches = RULES.filter(rule => rule.test(normalized));
  return matches.length === 1 ? { rule_id: matches[0].id, country: matches[0].country } : null;
}

export function governanceTier(metrics) {
  if (metrics.predictions >= TIER_A_MIN_PREDICTIONS && metrics.precision >= TIER_A_MIN_PRECISION &&
      metrics.holdout_predictions >= TIER_A_MIN_HOLDOUT && metrics.holdout_precision >= TIER_A_MIN_PRECISION) return 'A';
  return metrics.predictions > 0 && metrics.precision >= 0.95 ? 'B' : 'C';
}

export function buildQueries(project = 'gf-full-data') {
  if (!/^[A-Za-z0-9_-]+$/.test(project)) throw new Error('Invalid project');
  const source = `\`${project}.woocommerce_uk.orders_api\``;
  const postal = `NULLIF(TRIM(JSON_VALUE(SAFE.PARSE_JSON(raw_json), '$.shipping.postcode')), '')`;
  const country = `NULLIF(UPPER(TRIM(CAST(shipping_country AS STRING))), '')`;
  const base = `SELECT ${postal} postal_input, ${country} actual_country,
      MOD(ABS(FARM_FINGERPRINT(CONCAT(CAST(order_id AS STRING), '|postcode-holdout-v1'))), 5) = 0 is_holdout
      FROM ${source}`;
  return {
    labelled: `${base} WHERE ${postal} IS NOT NULL AND ${country} IS NOT NULL`,
    unknown: `${base} WHERE ${postal} IS NOT NULL AND ${country} IS NULL`
  };
}

const ratio = (n, d) => d ? Math.round(n / d * 1e6) / 1e6 : null;
const metric = (rows, predicate = () => true) => {
  const eligible = rows.filter(predicate);
  const predicted = eligible.filter(row => row.prediction);
  const correct = predicted.filter(row => row.prediction.country === row.actual_country).length;
  return { labelled_examples_eligible: eligible.length, predictions: predicted.length, correct, incorrect: predicted.length - correct,
    precision: ratio(correct, predicted.length), unresolved: eligible.length - predicted.length };
};

function evaluate(labelled) {
  const rows = labelled.map(row => ({ actual_country: row.actual_country, is_holdout: Boolean(row.is_holdout), prediction: classifyPostcode(row.postal_input) }));
  const countries = [...new Set(rows.map(r => r.actual_country))].sort();
  const ruleMetrics = RULES.map(rule => {
    const predictions = rows.filter(r => r.prediction?.rule_id === rule.id);
    const holdout = predictions.filter(r => r.is_holdout);
    const correct = predictions.filter(r => r.actual_country === rule.country).length;
    const holdoutCorrect = holdout.filter(r => r.actual_country === rule.country).length;
    const countryTotal = rows.filter(r => r.actual_country === rule.country).length;
    const metrics = { rule_id: rule.id, country: rule.country, rationale: rule.rationale, labelled_examples_eligible: predictions.length,
      predictions: predictions.length, correct, incorrect: predictions.length - correct, precision: ratio(correct, predictions.length),
      recall: ratio(correct, countryTotal), unresolved: countryTotal - correct, holdout_predictions: holdout.length,
      holdout_correct: holdoutCorrect, holdout_incorrect: holdout.length - holdoutCorrect, holdout_precision: ratio(holdoutCorrect, holdout.length) };
    return { ...metrics, governance_tier: governanceTier(metrics) };
  });
  const overall = metric(rows);
  const holdoutRows = rows.filter(r => r.is_holdout);
  const holdout = metric(holdoutRows);
  const errors = new Map();
  for (const row of rows.filter(r => r.prediction && r.prediction.country !== r.actual_country)) {
    const key = `${row.prediction.rule_id}|${row.prediction.country}|${row.actual_country}`;
    errors.set(key, (errors.get(key) || 0) + 1);
  }
  return { rows, ruleMetrics, countries,
    overall: { ...overall, classified_coverage: ratio(overall.predictions, rows.length), unresolved_coverage: ratio(overall.unresolved, rows.length) },
    holdout: { ...holdout, classified_coverage: ratio(holdout.predictions, holdoutRows.length), unresolved_coverage: ratio(holdout.unresolved, holdoutRows.length) },
    confusion: [...errors].map(([key, count]) => { const [rule_id, predicted_country, actual_country] = key.split('|'); return { rule_id, predicted_country, actual_country, count }; }) };
}

export function assertSafeOutput(value) {
  const visit = item => {
    if (!item || typeof item !== 'object') return;
    for (const [key, child] of Object.entries(item)) {
      if (PII_KEYS.test(key)) throw new Error(`Sensitive output field refused: ${key}`);
      visit(child);
    }
  };
  visit(value);
  return value;
}

export function compileReport(labelled, unknown, totalOrders = 38831) {
  const evaluation = evaluate(labelled);
  const tiers = Object.fromEntries(evaluation.ruleMetrics.map(r => [r.rule_id, r.governance_tier]));
  const simulated = unknown.map(row => classifyPostcode(row.postal_input));
  const tierA = simulated.filter(p => p && tiers[p.rule_id] === 'A');
  const tierB = simulated.filter(p => p && tiers[p.rule_id] === 'B');
  const counts = list => Object.fromEntries([...new Set(list.map(p => p.country))].sort().map(c => [c, list.filter(p => p.country === c).length]));
  const direct = labelled.length;
  const countryCounts = Object.fromEntries(evaluation.countries.map(country => {
    const count = labelled.filter(r => r.actual_country === country).length;
    return [country, { count, percentage: ratio(count * 100, direct) }];
  }));
  const coverage = inferred => ({ orders: direct + inferred, percentage: ratio((direct + inferred) * 100, totalOrders) });
  return assertSafeOutput({
    labelled_population: { count: direct, countries_represented: evaluation.countries, country_counts: countryCounts },
    classifier_rules: evaluation.ruleMetrics,
    governance_tiers: { A: { production_candidate: true, minimum_precision: TIER_A_MIN_PRECISION, minimum_predictions: TIER_A_MIN_PREDICTIONS, minimum_holdout_predictions: TIER_A_MIN_HOLDOUT }, B: { production_candidate: false, description: 'Supporting evidence only' }, C: { production_candidate: false, description: 'Ambiguous or unsupported' } },
    overall_validation: evaluation.overall,
    holdout_validation: evaluation.holdout,
    per_country_validation: evaluation.countries.map(country => { const subset = evaluation.rows.filter(r => r.actual_country === country); const m = metric(subset); return { country, labelled: subset.length, ...m, recall: ratio(m.correct, subset.length) }; }),
    confusion_summary: evaluation.confusion,
    ambiguous_formats: ['Generic 4-digit numeric', 'Generic 5-digit numeric', 'Other generic numeric lengths', 'JE/GY/IM UK-style outward areas', 'Alphanumeric structures outside the explicit GB, CA and IE grammars'],
    unknown_population_simulation: { evaluated: unknown.length, tier_a_classifiable: tierA.length, tier_b_only: tierB.length, unresolved: unknown.length - tierA.length - tierB.length, tier_a_predicted_country_counts: counts(tierA), tier_b_predicted_country_counts: counts(tierB) },
    sensitivity_analysis: { direct_evidence_only: coverage(0), tier_a_inference_only: coverage(tierA.length), tier_a_plus_tier_b_if_manually_approved: coverage(tierA.length + tierB.length) },
    proposed_provenance: { direct: 'direct_woo_shipping_country', inferred: 'inferred_shipping_postcode_tier_a', unresolved: 'unresolved', inference_method: 'deterministic_postcode_syntax', classifier_version: CLASSIFIER_VERSION, confidence_field: 'evidence_tier' },
    privacy_notes: ['Postal values are selected only into process memory, normalized, classified, and discarded.', 'Output is aggregate-only and guarded against sensitive field names.', 'No identifiers or sanitized postal fragments are emitted.'],
    limitations: ['Syntax establishes compatibility, not physical delivery or customer residence.', 'Shared numeric formats cannot identify a country and remain unresolved.', 'Tier eligibility is dataset-dependent and must be revalidated before production use.'],
    recommendation: tierA.length ? 'Review the aggregate results; only Tier A rules are candidates for a separately approved provenance-preserving enrichment. This diagnostic performs no writes.' : 'Do not enrich automatically: no rule met Tier A governance on this validation population.'
  });
}

export async function runDiagnostic({ bigquery, project = 'gf-full-data' }) {
  const queries = buildQueries(project);
  for (const sql of Object.values(queries)) assertReadOnly(sql);
  const [labelledResult, unknownResult] = await Promise.all([bigquery.query({ query: queries.labelled }), bigquery.query({ query: queries.unknown })]);
  return compileReport(labelledResult[0], unknownResult[0]);
}

export function conclusion(report) {
  const a = report.unknown_population_simulation;
  const v = report.overall_validation;
  const coverage = report.sensitivity_analysis.tier_a_inference_only;
  return `Conclusion: postcode syntax can safely recover country only through rules that pass Tier A; ${v.correct}/${v.predictions} validation predictions were correct (${v.precision === null ? 'n/a' : (v.precision * 100).toFixed(3) + '%'}). Tier A classifies ${a.tier_a_classifiable}/${a.evaluated} postcode-only orders, producing ${coverage.orders}/${38831} (${coverage.percentage}%) total historical coverage. Generic numeric formats and unsupported or overlapping alphanumeric formats remain unresolved. Proceed only after aggregate review and separate approval; this diagnostic does not enrich production.`;
}

async function main() {
  const arg = process.argv.indexOf('--project');
  const project = arg >= 0 ? process.argv[arg + 1] : process.env.GOOGLE_PROJECT_ID || 'gf-full-data';
  const credentials = process.env.GOOGLE_SERVICE_ACCOUNT_JSON ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON) : undefined;
  const report = await runDiagnostic({ bigquery: new BigQuery({ projectId: project, ...(credentials ? { credentials } : {}) }), project });
  console.log(JSON.stringify(report, null, 2));
  console.log(conclusion(report));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(`Woo postcode feasibility failed: ${error.message}`); process.exitCode = 1; });
