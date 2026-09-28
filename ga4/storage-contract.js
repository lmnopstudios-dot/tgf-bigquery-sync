import { assertDatasetIdentifier } from '../bigquery/dataset-location.js';

export const GA4_DEFAULT_DATASET = 'ga4';
export const GA4_DATE_FIELD = 'date';
export const GA4_DEVICE_TABLE = 'conversion_device';
export const GA4_COVERAGE_TABLE = 'conversion_coverage';
export const GA4_COVERAGE_STATUSES = Object.freeze(['reportable', 'limited', 'unavailable']);

export function ga4Dataset(value = process.env.GA4_DATASET || GA4_DEFAULT_DATASET) {
  return assertDatasetIdentifier(value);
}
