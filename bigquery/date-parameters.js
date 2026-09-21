import { BigQuery } from '@google-cloud/bigquery';

// Keep DATE query values on the same representation used by the production-
// proven Search Console pipeline. Explicit DATE types are supplied by callers.
export const bigQueryDate = value => BigQuery.date(value);

export function bigQueryDateParameters(values) {
  return Object.fromEntries(Object.entries(values).map(([name, value]) => [name, bigQueryDate(value)]));
}

export function describeDateParameter(value, declaredParameterType = 'DATE') {
  const runtimeValueType = typeof value;
  const isObject = value !== null && runtimeValueType === 'object';
  return {
    declared_parameter_type: declaredParameterType,
    runtime_value_type: runtimeValueType,
    runtime_constructor: isObject ? value.constructor?.name || null : null,
    runtime_shape: {
      is_string: runtimeValueType === 'string',
      is_object: isObject,
      object_keys: isObject ? Object.keys(value).sort() : []
    },
    date_value: runtimeValueType === 'string' ? value : (isObject && typeof value.value === 'string' ? value.value : null)
  };
}
