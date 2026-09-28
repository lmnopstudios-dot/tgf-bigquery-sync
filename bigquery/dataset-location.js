const IDENTIFIER = /^[A-Za-z0-9_-]+$/;

export function assertDatasetIdentifier(value) {
  if (!IDENTIFIER.test(value)) throw new Error('Invalid BigQuery identifier');
  return value;
}

// Configuration is only a creation default. Metadata is authoritative for an
// existing dataset because every BigQuery job must execute in that location.
export async function datasetLocation(bigquery, project, dataset, { fallback = null } = {}) {
  assertDatasetIdentifier(project); assertDatasetIdentifier(dataset);
  if (typeof bigquery.dataset !== 'function') {
    if (fallback) return String(fallback).toUpperCase();
    throw new Error(`Cannot resolve location for dataset ${project}:${dataset}`);
  }
  const handle = bigquery.dataset(dataset, { projectId: project });
  if (typeof handle.getMetadata !== 'function') {
    if (fallback) return String(fallback).toUpperCase();
    throw new Error(`Cannot resolve location for dataset ${project}:${dataset}`);
  }
  try {
    const [metadata] = await handle.getMetadata();
    if (!metadata?.location) throw new Error(`Dataset ${project}:${dataset} metadata has no location`);
    return String(metadata.location).toUpperCase();
  } catch (error) {
    if (fallback && Number(error?.code) === 404) return String(fallback).toUpperCase();
    throw error;
  }
}
