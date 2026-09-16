const MATRIXIFY_APP_ID = 'gid://shopify/App/1758145';
const ORDER_PAGE_SIZE = 50;
const MOMENT_PAGE_SIZE = 25;
const MAX_MOMENT_PAGES = 100;

export const ORDER_ACQUISITION_SCHEMA = [
  ['order_id', 'STRING', 'REQUIRED'], ['order_created_at', 'TIMESTAMP'],
  ['order_updated_at', 'TIMESTAMP'], ['attribution_handle', 'STRING'],
  ['attribution_display_name', 'STRING'], ['source_name', 'STRING'],
  ['app_id', 'STRING'], ['app_name', 'STRING'],
  ['is_matrixify_import', 'BOOL', 'REQUIRED'],
  ['journey_available', 'BOOL', 'REQUIRED'], ['journey_ready', 'BOOL'],
  ['customer_order_index', 'INT64'], ['days_to_conversion', 'INT64'],
  ['journey_moment_count', 'INT64', 'REQUIRED'],
  ['journey_pagination_complete', 'BOOL', 'REQUIRED'],
  ...['first', 'last'].flatMap(role => [
    [`${role}_visit_id`, 'STRING'], [`${role}_visit_at`, 'TIMESTAMP'],
    [`${role}_visit_source`, 'STRING'], [`${role}_visit_source_description`, 'STRING'],
    [`${role}_visit_source_type`, 'STRING'], [`${role}_visit_landing_host`, 'STRING'],
    [`${role}_visit_landing_path`, 'STRING'], [`${role}_visit_referrer_host`, 'STRING'],
    ...['source', 'medium', 'campaign', 'content', 'term'].map(
      field => [`${role}_visit_utm_${field}`, 'STRING']
    )
  ]),
  ['synced_at', 'TIMESTAMP', 'REQUIRED']
].map(([name, type, mode]) => ({ name, type, ...(mode ? { mode } : {}) }));

export const ORDER_JOURNEY_MOMENTS_SCHEMA = [
  ['order_id', 'STRING', 'REQUIRED'], ['order_created_at', 'TIMESTAMP'],
  ['moment_id', 'STRING', 'REQUIRED'], ['moment_sequence', 'INT64', 'REQUIRED'],
  ['moment_type', 'STRING', 'REQUIRED'], ['occurred_at', 'TIMESTAMP'],
  ['source', 'STRING'], ['source_description', 'STRING'], ['source_type', 'STRING'],
  ['referral_code_present', 'BOOL', 'REQUIRED'], ['landing_host', 'STRING'],
  ['landing_path', 'STRING'], ['referrer_host', 'STRING'],
  ...['source', 'medium', 'campaign', 'content', 'term'].map(field => [`utm_${field}`, 'STRING']),
  ['is_first_visit', 'BOOL', 'REQUIRED'], ['is_last_visit', 'BOOL', 'REQUIRED'],
  ['synced_at', 'TIMESTAMP', 'REQUIRED']
].map(([name, type, mode]) => ({ name, type, ...(mode ? { mode } : {}) }));

export class AcquisitionValidationError extends Error {}

export function parseDateRange(body = {}) {
  const strictDate = (value, name) => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new AcquisitionValidationError(`${name} must be an ISO date in YYYY-MM-DD format`);
    }
    const date = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
      throw new AcquisitionValidationError(`${name} must be a valid calendar date`);
    }
    return date;
  };
  const start = strictDate(body.start_date, 'start_date');
  const end = strictDate(body.end_date, 'end_date');
  if (start > end) throw new AcquisitionValidationError('start_date must not be after end_date');
  const endExclusive = new Date(end);
  endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
  return { startDate: body.start_date, endDate: body.end_date, endExclusive: endExclusive.toISOString() };
}

function safeUrl(value, includePath) {
  if (!value) return { host: null, path: null };
  try {
    const url = new URL(value, 'https://relative.invalid');
    const decoded = (() => { try { return decodeURIComponent(url.pathname); } catch { return url.pathname; } })();
    const path = /@|(?:token|auth|session|checkout)/i.test(decoded) ? '[REDACTED_PATH]' : decoded;
    return {
      host: url.hostname === 'relative.invalid' ? null : url.hostname.toLowerCase(),
      path: includePath ? (path || '/') : null
    };
  } catch {
    return { host: null, path: includePath ? '[INVALID_PATH]' : null };
  }
}

function visitValues(visit, prefix) {
  const landing = safeUrl(visit?.landingPage, true);
  const referrer = safeUrl(visit?.referrerUrl, false);
  const utm = visit?.utmParameters;
  return {
    [`${prefix}_visit_id`]: visit?.id ?? null,
    [`${prefix}_visit_at`]: visit?.occurredAt ?? null,
    [`${prefix}_visit_source`]: visit?.source ?? null,
    [`${prefix}_visit_source_description`]: visit?.sourceDescription ?? null,
    [`${prefix}_visit_source_type`]: visit?.sourceType ?? null,
    [`${prefix}_visit_landing_host`]: landing.host,
    [`${prefix}_visit_landing_path`]: landing.path,
    [`${prefix}_visit_referrer_host`]: referrer.host,
    ...Object.fromEntries(['source', 'medium', 'campaign', 'content', 'term'].map(
      field => [`${prefix}_visit_utm_${field}`, utm?.[field] ?? null]
    ))
  };
}

function momentRow(order, moment, sequence, firstId, lastId, syncedAt) {
  const landing = safeUrl(moment?.landingPage, true);
  const referrer = safeUrl(moment?.referrerUrl, false);
  return {
    order_id: order.id, order_created_at: order.createdAt,
    moment_id: moment.id, moment_sequence: sequence,
    moment_type: moment.__typename ?? 'UnknownCustomerMoment',
    occurred_at: moment.occurredAt ?? null,
    source: moment.source ?? null, source_description: moment.sourceDescription ?? null,
    source_type: moment.sourceType ?? null,
    referral_code_present: Boolean(moment.referralCode),
    landing_host: landing.host, landing_path: landing.path, referrer_host: referrer.host,
    ...Object.fromEntries(['source', 'medium', 'campaign', 'content', 'term'].map(
      field => [`utm_${field}`, moment.utmParameters?.[field] ?? null]
    )),
    is_first_visit: Boolean(firstId && moment.id === firstId),
    is_last_visit: Boolean(lastId && moment.id === lastId), synced_at: syncedAt
  };
}

const VISIT_FIELDS = `__typename ... on CustomerVisit { id occurredAt landingPage referrerUrl
  referralCode source sourceDescription sourceType
  utmParameters { source medium campaign content term } }`;

const ORDERS_QUERY = `query AcquisitionOrders($cursor: String, $query: String!) {
  orders(first: ${ORDER_PAGE_SIZE}, after: $cursor, sortKey: CREATED_AT, query: $query) {
    pageInfo { hasNextPage endCursor }
    nodes { id createdAt updatedAt sourceName attribution { handle displayName } app { id name }
      customerJourneySummary { ready customerOrderIndex daysToConversion
        firstVisit { ${VISIT_FIELDS} } lastVisit { ${VISIT_FIELDS} }
        moments(first: ${MOMENT_PAGE_SIZE}) { pageInfo { hasNextPage endCursor } nodes { ${VISIT_FIELDS} } }
      }
    }
  }
}`;

const MOMENTS_QUERY = `query AcquisitionMoments($id: ID!, $cursor: String) {
  order(id: $id) { customerJourneySummary {
    moments(first: ${MOMENT_PAGE_SIZE}, after: $cursor) {
      pageInfo { hasNextPage endCursor } nodes { ${VISIT_FIELDS} }
    }
  } }
}`;

async function requestWithRetry(graphql, query, variables, sleep = ms => new Promise(r => setTimeout(r, ms))) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    try { return await graphql(query, variables); } catch (error) {
      lastError = error;
      const retryable = error?.name === 'ShopifyGraphQLError' || error?.name === 'TypeError' ||
        error?.code === 'ECONNRESET' || error?.status === 429 || error?.status >= 500;
      if (!retryable || attempt === 3) throw error;
      await sleep(500 * (2 ** attempt));
    }
  }
  throw lastError;
}

export async function extractAcquisition({
  graphql, startDate, endExclusive, now = () => new Date(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
}) {
  const orders = [];
  let cursor = null;
  do {
    const data = await requestWithRetry(graphql, ORDERS_QUERY, {
      cursor, query: `created_at:>=${startDate} created_at:<${endExclusive.slice(0, 10)}`
    }, sleep);
    const connection = data.orders;
    if (!connection?.pageInfo || !Array.isArray(connection.nodes)) throw new Error('Invalid Shopify orders connection');
    orders.push(...connection.nodes);
    if (!connection.pageInfo.hasNextPage) break;
    if (!connection.pageInfo.endCursor || connection.pageInfo.endCursor === cursor) throw new Error('Invalid Shopify order pagination cursor');
    cursor = connection.pageInfo.endCursor;
  } while (true);

  const syncedAt = now().toISOString();
  const acquisition = [];
  const moments = [];
  for (const order of orders) {
    const journey = order.customerJourneySummary;
    const connection = journey?.moments;
    const orderMoments = [...(connection?.nodes ?? [])];
    let pageInfo = connection?.pageInfo;
    let complete = journey === null || journey === undefined || Boolean(pageInfo);
    let pages = journey ? 1 : 0;
    try {
      while (pageInfo?.hasNextPage) {
        if (pages >= MAX_MOMENT_PAGES) throw new Error('Journey moment safety page cap exceeded');
        if (!pageInfo.endCursor) throw new Error('Invalid journey moment pagination cursor');
        const data = await requestWithRetry(graphql, MOMENTS_QUERY, { id: order.id, cursor: pageInfo.endCursor }, sleep);
        const next = data.order?.customerJourneySummary?.moments;
        if (!next?.pageInfo || !Array.isArray(next.nodes)) throw new Error('Invalid journey moment connection');
        orderMoments.push(...next.nodes);
        pageInfo = next.pageInfo;
        pages++;
        await sleep(100);
      }
    } catch {
      complete = false;
    }
    const firstId = journey?.firstVisit?.id ?? null;
    const lastId = journey?.lastVisit?.id ?? null;
    orderMoments.forEach((moment, index) => moments.push(
      momentRow(order, moment, index + 1, firstId, lastId, syncedAt)
    ));
    acquisition.push({
      order_id: order.id, order_created_at: order.createdAt, order_updated_at: order.updatedAt,
      attribution_handle: order.attribution?.handle ?? null,
      attribution_display_name: order.attribution?.displayName ?? null,
      source_name: order.sourceName ?? null, app_id: order.app?.id ?? null,
      app_name: order.app?.name ?? null,
      is_matrixify_import: order.app?.id === MATRIXIFY_APP_ID,
      journey_available: Boolean(journey), journey_ready: journey?.ready ?? null,
      customer_order_index: journey?.customerOrderIndex ?? null,
      days_to_conversion: journey?.daysToConversion ?? null,
      journey_moment_count: orderMoments.length,
      journey_pagination_complete: complete && !pageInfo?.hasNextPage,
      ...visitValues(journey?.firstVisit, 'first'), ...visitValues(journey?.lastVisit, 'last'),
      synced_at: syncedAt
    });
  }
  validateRows(acquisition, moments);
  return { acquisition, moments };
}

export function validateRows(acquisition, moments) {
  const allowedAcquisition = new Set(ORDER_ACQUISITION_SCHEMA.map(field => field.name));
  const allowedMoments = new Set(ORDER_JOURNEY_MOMENTS_SCHEMA.map(field => field.name));
  const ids = new Set();
  const orderById = new Map();
  for (const row of acquisition) {
    if (!row.order_id || ids.has(row.order_id)) throw new AcquisitionValidationError('Duplicate or missing order_id');
    ids.add(row.order_id);
    orderById.set(row.order_id, row);
    const created = row.order_created_at ? new Date(row.order_created_at) : null;
    const updated = row.order_updated_at ? new Date(row.order_updated_at) : null;
    if ((created && !Number.isFinite(created.getTime())) || (updated && !Number.isFinite(updated.getTime())) ||
        (created && updated && updated < created)) {
      throw new AcquisitionValidationError('order_updated_at predates order_created_at');
    }
    if (row.is_matrixify_import !== (row.app_id === MATRIXIFY_APP_ID)) throw new AcquisitionValidationError('Invalid Matrixify classification');
    if (Object.keys(row).some(key => !allowedAcquisition.has(key))) throw new AcquisitionValidationError('Unexpected acquisition field');
  }
  const momentIds = new Set();
  const sequences = new Map();
  for (const row of moments) {
    const key = `${row.order_id}\0${row.moment_id}`;
    if (!row.moment_id || momentIds.has(key)) throw new AcquisitionValidationError('Duplicate or missing order/moment identity');
    momentIds.add(key);
    if (!ids.has(row.order_id)) throw new AcquisitionValidationError('Journey moment references an unknown order');
    const parent = orderById.get(row.order_id);
    if (row.is_first_visit !== Boolean(parent.first_visit_id && row.moment_id === parent.first_visit_id) ||
        row.is_last_visit !== Boolean(parent.last_visit_id && row.moment_id === parent.last_visit_id)) {
      throw new AcquisitionValidationError('Journey first/last role flag is inconsistent');
    }
    const expected = (sequences.get(row.order_id) ?? 0) + 1;
    if (row.moment_sequence !== expected) throw new AcquisitionValidationError('Non-deterministic moment sequence');
    sequences.set(row.order_id, expected);
    if (Object.keys(row).some(keyName => !allowedMoments.has(keyName))) throw new AcquisitionValidationError('Unexpected journey moment field');
  }
  for (const row of acquisition) {
    if (row.journey_moment_count !== undefined && row.journey_moment_count !== (sequences.get(row.order_id) ?? 0)) {
      throw new AcquisitionValidationError('Journey moment count does not match observed moments');
    }
  }
}

async function insertRows(table, rows) {
  for (let index = 0; index < rows.length; index += 500) await table.insert(rows.slice(index, index + 500));
}

export async function promoteAcquisitionWindow({ bigquery, projectId, datasetName = 'shopify_data', startDate, endExclusive, acquisition, moments }) {
  validateRows(acquisition, moments);
  const dataset = bigquery.dataset(datasetName);
  const [datasetExists] = await dataset.exists();
  if (!datasetExists) await bigquery.createDataset(datasetName);
  for (const [name, schema] of [['order_acquisition', ORDER_ACQUISITION_SCHEMA], ['order_journey_moments', ORDER_JOURNEY_MOMENTS_SCHEMA]]) {
    const [exists] = await dataset.table(name).exists();
    if (!exists) await dataset.createTable(name, { schema });
  }
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const acquisitionStageName = `_staging_order_acquisition_${suffix}`;
  const momentsStageName = `_staging_order_journey_moments_${suffix}`;
  const [acquisitionStage] = await dataset.createTable(acquisitionStageName, { schema: ORDER_ACQUISITION_SCHEMA, expirationTime: Date.now() + 86400000 });
  let momentsStage;
  try {
    [momentsStage] = await dataset.createTable(momentsStageName, { schema: ORDER_JOURNEY_MOMENTS_SCHEMA, expirationTime: Date.now() + 86400000 });
    await insertRows(acquisitionStage, acquisition);
    await insertRows(momentsStage, moments);
    const [counts] = await bigquery.query({ query: `SELECT
      (SELECT COUNT(*) FROM \`${projectId}.${datasetName}.${acquisitionStageName}\`) acquisition_count,
      (SELECT COUNT(*) FROM \`${projectId}.${datasetName}.${momentsStageName}\`) moment_count` });
    if (Number(counts[0]?.acquisition_count) !== acquisition.length || Number(counts[0]?.moment_count) !== moments.length) {
      throw new AcquisitionValidationError('BigQuery staging counts do not match source rows');
    }
    await bigquery.query({ query: `BEGIN TRANSACTION;
      DELETE FROM \`${projectId}.${datasetName}.order_journey_moments\`
        WHERE order_created_at >= TIMESTAMP(@startDate) AND order_created_at < TIMESTAMP(@endExclusive);
      DELETE FROM \`${projectId}.${datasetName}.order_acquisition\`
        WHERE order_created_at >= TIMESTAMP(@startDate) AND order_created_at < TIMESTAMP(@endExclusive);
      INSERT INTO \`${projectId}.${datasetName}.order_acquisition\` SELECT * FROM \`${projectId}.${datasetName}.${acquisitionStageName}\`;
      INSERT INTO \`${projectId}.${datasetName}.order_journey_moments\` SELECT * FROM \`${projectId}.${datasetName}.${momentsStageName}\`;
      COMMIT TRANSACTION;`, params: { startDate: `${startDate}T00:00:00.000Z`, endExclusive } });
    return { acquisition_rows: acquisition.length, journey_moment_rows: moments.length, coordinated_transactional_window_replacement: true };
  } finally {
    await Promise.allSettled([acquisitionStage.delete({ ignoreNotFound: true }), momentsStage?.delete({ ignoreNotFound: true })]);
  }
}

export async function syncShopifyAcquisition(options) {
  const range = parseDateRange(options.body);
  const rows = await extractAcquisition({ ...options, ...range });
  const promotion = await promoteAcquisitionWindow({ ...options, ...range, ...rows });
  return { ...range, ...promotion, incomplete_journey_orders: rows.acquisition.filter(row => !row.journey_pagination_complete).length };
}
