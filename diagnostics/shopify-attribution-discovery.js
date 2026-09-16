#!/usr/bin/env node

/**
 * Read-only Shopify attribution discovery diagnostic.
 *
 * This file intentionally has no imports from server.js: importing the server would initialise
 * BigQuery and production routes. Every Shopify GraphQL document below is a `query`; the script
 * contains no mutation, Bulk Operation launch, file write, or ingestion-route call.
 */

const API_VERSION = '2026-07';
const MATRIXIFY_SOURCE_APP_ID = 'gid://shopify/App/1758145';
const MOMENT_PAGE_SIZE = 10;
const STRATUM_SIZE = 10;
const TARGET_ORDER_FIELDS = [
  'app', 'attribution', 'sourceName', 'sourceIdentifier', 'sourceUrl', 'channelInformation',
  'landingPageDisplayText', 'referringSite', 'customerJourneySummary'
];
const TARGET_SUMMARY_FIELDS = [
  'ready', 'customerOrderIndex', 'daysToConversion', 'firstVisit', 'lastVisit', 'moments'
];
const TARGET_VISIT_FIELDS = [
  'id', 'occurredAt', 'landingPage', 'referrerUrl', 'referralCode', 'source',
  'sourceDescription', 'sourceType', 'utmParameters', 'marketingEvent'
];
const TARGET_UTM_FIELDS = ['source', 'medium', 'campaign', 'content', 'term'];

const output = {
  diagnostic: 'shopify_attribution_discovery',
  api_version: API_VERSION,
  generated_at: new Date().toISOString(),
  safety: {
    read_only: true,
    graphql_operations: ['query'],
    shopify_mutations: false,
    bulk_operation_launched: false,
    bigquery_writes: false,
    ingestion_routes_invoked: false,
    secrets_printed: false,
    customer_pii_printed: false,
    urls_sanitized_to_host_and_path: true
  },
  access_scopes: [],
  schema: {},
  order_attribution_definitions: {},
  order_attribution_comparison: {},
  capabilities: {},
  sample_methodology: {},
  representative_orders: [],
  historical_coverage: {},
  guest_order_behavior: {},
  matrixify_behavior: {},
  journey_pagination: {},
  graphql_cost: {},
  bulk_operations: {},
  implementation_recommendation: {},
  limitations: [],
  errors: []
};

const costs = new Map();

function safeError(error, stage) {
  const messages = error?.graphqlErrors?.map(item => item.message) || [error?.message || String(error)];
  return { stage, messages: messages.map(redactText) };
}

function redactText(value) {
  return String(value)
    .replace(/https?:\/\/[^\s"']+/gi, '[REDACTED_URL]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]')
    .replace(/shpat_[A-Za-z0-9_-]+/g, '[REDACTED_TOKEN]')
    .slice(0, 1000);
}

function sanitizeEvidence(value) {
  if (value == null) return null;
  return redactText(value)
    .replace(/(?:\+?\d[\d ()-]{7,}\d)/g, '[REDACTED_PHONE_LIKE_VALUE]')
    .slice(0, 200);
}

function sanitizeObject(value) {
  if (value == null || typeof value !== 'object') return typeof value === 'string' ? sanitizeEvidence(value) : value;
  if (Array.isArray(value)) return value.map(sanitizeObject);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeObject(item)]));
}

function sanitizeUrl(value, includePath = true) {
  if (!value) return null;
  try {
    const url = new URL(value, 'https://relative.invalid');
    return {
      hostname: url.hostname === 'relative.invalid' ? null : url.hostname.toLowerCase(),
      pathname: includePath ? sanitizePath(url.pathname) : undefined
    };
  } catch {
    return { hostname: null, pathname: includePath ? sanitizePath(String(value).split(/[?#]/, 1)[0]) : undefined };
  }
}

function sanitizePath(pathname) {
  if (!pathname) return '/';
  const decoded = (() => { try { return decodeURIComponent(pathname); } catch { return pathname; } })();
  if (/@|(?:token|auth|session|checkout)/i.test(decoded)) return '[REDACTED_PATH]';
  return decoded.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED]');
}

function typeRef(ref) {
  if (!ref) return null;
  if (ref.kind === 'NON_NULL') return `${typeRef(ref.ofType)}!`;
  if (ref.kind === 'LIST') return `[${typeRef(ref.ofType)}]`;
  return ref.name;
}

function namedType(ref) {
  let cursor = ref;
  while (cursor?.ofType) cursor = cursor.ofType;
  return cursor?.name || null;
}

function fieldMetadata(field) {
  return {
    type: typeRef(field.type),
    deprecated: Boolean(field.isDeprecated),
    deprecation_reason: field.deprecationReason || null,
    arguments: (field.args || []).map(arg => ({
      name: arg.name,
      type: typeRef(arg.type),
      default_value: arg.defaultValue ?? null,
      deprecated: Boolean(arg.isDeprecated),
      deprecation_reason: arg.deprecationReason || null
    }))
  };
}

function pickFields(type, names) {
  const fields = new Map((type?.fields || []).map(field => [field.name, field]));
  return Object.fromEntries(names.map(name => [name, fields.has(name) ? fieldMetadata(fields.get(name)) : { exists: false }]));
}

function costMetadata(extensions) {
  const cost = extensions?.cost;
  if (!cost) return null;
  return {
    requested_query_cost: cost.requestedQueryCost ?? null,
    actual_query_cost: cost.actualQueryCost ?? null,
    throttle_currently_available: cost.throttleStatus?.currentlyAvailable ?? null,
    throttle_restore_rate: cost.throttleStatus?.restoreRate ?? null
  };
}

function recordCost(queryClass, extensions) {
  const item = costMetadata(extensions);
  if (!item) return;
  if (!costs.has(queryClass)) costs.set(queryClass, []);
  costs.get(queryClass).push(item);
}

async function authenticate(shop, clientId, clientSecret) {
  const response = await fetch(`https://${shop}.myshopify.com/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret })
  });
  let body;
  try { body = await response.json(); } catch { throw new Error(`Shopify OAuth returned HTTP ${response.status} with a non-JSON body`); }
  if (!response.ok || !body.access_token) throw new Error(`Shopify OAuth failed with HTTP ${response.status}`);
  return body.access_token;
}

async function graphql(shop, token, query, variables, queryClass) {
  if (!/^\s*query\b/.test(query)) throw new Error('Safety guard rejected a non-query GraphQL operation');
  const response = await fetch(`https://${shop}.myshopify.com/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables })
  });
  let payload;
  try { payload = await response.json(); } catch { throw new Error(`Shopify GraphQL returned HTTP ${response.status} with a non-JSON body`); }
  recordCost(queryClass, payload.extensions);
  if (!response.ok || payload.errors?.length) {
    const error = new Error(`Shopify GraphQL ${queryClass} query failed`);
    error.graphqlErrors = payload.errors || [{ message: `HTTP ${response.status}` }];
    throw error;
  }
  return payload.data;
}

const INTROSPECT_TYPE = `query DiagnosticType($name: String!) {
  __type(name: $name) {
    kind name description
    interfaces { name kind }
    possibleTypes { name kind }
    fields(includeDeprecated: true) {
      name description isDeprecated deprecationReason
      args(includeDeprecated: true) {
        name description defaultValue isDeprecated deprecationReason
        type { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } }
      }
      type { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } }
    }
  }
}`;

async function inspectType(ctx, name) {
  const data = await graphql(ctx.shop, ctx.token, INTROSPECT_TYPE, { name }, 'schema_introspection');
  return data.__type;
}

function field(type, name) {
  return type?.fields?.find(item => item.name === name);
}

function selectionIf(type, name, subSelection = '') {
  return field(type, name) ? `${name}${subSelection ? ` { ${subSelection} }` : ''}` : '';
}

const SAFE_ATTRIBUTION_FIELD = /^(id|handle|displayName|name|icon|type|classification|category|app|channel|channelDefinition)$/i;

function safeSemanticSelection(type, types) {
  return (type?.fields || []).flatMap(item => {
    if (item.args?.some(arg => arg.defaultValue == null && arg.type?.kind === 'NON_NULL')) return [];
    const kind = item.type?.kind === 'NON_NULL' ? item.type.ofType?.kind : item.type?.kind;
    if (['SCALAR', 'ENUM'].includes(kind)) return [item.name];
    if (!SAFE_ATTRIBUTION_FIELD.test(item.name)) return [];
    const related = types[namedType(item.type)];
    const children = (related?.fields || [])
      .filter(child => /^(id|handle|displayName|name|type|classification|url)$/i.test(child.name))
      .filter(child => ['SCALAR', 'ENUM'].includes(child.type?.kind === 'NON_NULL' ? child.type.ofType?.kind : child.type?.kind))
      .map(child => child.name);
    return children.length ? [`${item.name} { ${children.join(' ')} }`] : [];
  });
}

function safeAttribution(value) {
  if (!value || typeof value !== 'object') return value ?? null;
  if (Array.isArray(value)) return value.map(safeAttribution);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (/icon|url/i.test(key) && typeof item === 'string') return [key, sanitizeUrl(item, false)];
    return [key, typeof item === 'object' ? safeAttribution(item) : sanitizeEvidence(item)];
  }));
}

function visitSelection(types) {
  const visit = types.CustomerVisit;
  if (!visit) return '__typename';
  const scalars = ['id', 'occurredAt', 'referralCode', 'source', 'sourceDescription', 'sourceType']
    .filter(name => field(visit, name));
  const urls = ['landingPage', 'referrerUrl'].filter(name => field(visit, name));
  const utm = field(visit, 'utmParameters');
  const utmType = types.UTMParameters;
  const utmFields = TARGET_UTM_FIELDS.filter(name => field(utmType, name));
  const customerVisitFields = [...scalars, ...urls, utm && utmFields.length ? `utmParameters { ${utmFields.join(' ')} }` : '']
    .filter(Boolean).join(' ');
  // Moments is normally an interface. An inline fragment remains valid when this selection is
  // reused beneath firstVisit/lastVisit and prevents us from assuming which fields the interface owns.
  return `__typename ... on CustomerVisit { ${customerVisitFields} }`;
}

function buildSelections(types) {
  const order = types.Order;
  const summary = types.CustomerJourneySummary;
  const appType = types.App;
  const appFields = ['id', 'name'].filter(name => field(appType, name));
  const orderParts = ['id', 'createdAt', 'updatedAt'].filter(name => field(order, name));
  if (field(order, 'customer')) orderParts.push('customer { id }'); // Used only as a boolean; never emitted.
  if (field(order, 'app') && appFields.length) orderParts.push(`app { ${appFields.join(' ')} }`);
  const attributionField = field(order, 'attribution');
  const attributionType = types[namedType(attributionField?.type)];
  const attributionFields = safeSemanticSelection(attributionType, types);
  if (attributionField && attributionFields.length) orderParts.push(`attribution { ${attributionFields.join(' ')} }`);
  for (const name of ['sourceName', 'sourceIdentifier']) if (field(order, name)) orderParts.push(name);
  for (const name of ['sourceUrl', 'landingPageDisplayText', 'referringSite']) if (field(order, name)) orderParts.push(name);

  const channelField = field(order, 'channelInformation');
  const channelName = namedType(channelField?.type);
  const channelType = channelName ? types[channelName] : null;
  const safeChannelFields = (channelType?.fields || [])
    .filter(item => ['id', 'name', 'channelDefinition'].includes(item.name) && ['SCALAR', 'ENUM'].includes(item.type.kind))
    .map(item => item.name);
  if (channelField && safeChannelFields.length) orderParts.push(`channelInformation { ${safeChannelFields.join(' ')} }`);

  const summaryParts = ['ready', 'customerOrderIndex', 'daysToConversion'].filter(name => field(summary, name));
  const visitFields = visitSelection(types);
  for (const name of ['firstVisit', 'lastVisit']) if (field(summary, name)) summaryParts.push(`${name} { ${visitFields} }`);
  const moments = field(summary, 'moments');
  const momentArgs = new Set((moments?.args || []).map(arg => arg.name));
  if (moments && momentArgs.has('first')) {
    summaryParts.push(`moments(first: $momentFirst) { edges { cursor node { ${visitFields} } } pageInfo { hasNextPage endCursor } }`);
  }
  if (field(order, 'customerJourneySummary') && summaryParts.length) {
    orderParts.push(`customerJourneySummary { ${summaryParts.join(' ')} }`);
  }
  return { order: orderParts.join(' '), visit: visitFields, momentsPaginated: Boolean(moments && momentArgs.has('first')) };
}

function safeVisit(visit) {
  if (!visit) return null;
  return {
    typename: visit.__typename || null,
    id: visit.id || null,
    occurred_at: visit.occurredAt || null,
    landing: sanitizeUrl(visit.landingPage, true),
    referrer: sanitizeUrl(visit.referrerUrl, false),
    referral_code_present: Boolean(visit.referralCode),
    source: sanitizeEvidence(visit.source),
    source_description: sanitizeEvidence(visit.sourceDescription),
    source_type: sanitizeEvidence(visit.sourceType),
    utm: visit.utmParameters ? Object.fromEntries(Object.entries(visit.utmParameters).filter(([, value]) => value != null).map(([key, value]) => [key, sanitizeEvidence(value)])) : null
  };
}

function safeOrder(order, category = null, queryCost = null) {
  const journey = order.customerJourneySummary;
  const edges = journey?.moments?.edges || [];
  return {
    sample_category: category,
    order_id: order.id,
    created_at: order.createdAt,
    updated_at: order.updatedAt,
    origin: {
      classification: order.app?.id === MATRIXIFY_SOURCE_APP_ID ? 'matrixify_import' : (/pos/i.test(order.sourceName || '') ? 'pos_non_web' : 'native_or_other'),
      app_id: order.app?.id || null,
      app_name: sanitizeEvidence(order.app?.name),
      attribution: safeAttribution(order.attribution),
      source_name: sanitizeEvidence(order.sourceName),
      source_identifier: sanitizeEvidence(order.sourceIdentifier),
      source_url: sanitizeUrl(order.sourceUrl, true),
      landing_page_display: sanitizeUrl(order.landingPageDisplayText, true),
      referring_site: sanitizeUrl(order.referringSite, false),
      channel_information: sanitizeObject(order.channelInformation)
    },
    guest_order: !order.customer,
    journey_available: Boolean(journey),
    journey_ready: journey?.ready ?? null,
    customer_order_index: journey?.customerOrderIndex ?? null,
    days_to_conversion: journey?.daysToConversion ?? null,
    initial_moment_count: edges.length,
    first_visit: safeVisit(journey?.firstVisit),
    last_visit: safeVisit(journey?.lastVisit),
    initial_page_has_next: journey?.moments?.pageInfo?.hasNextPage ?? null,
    graphql_query_cost: queryCost
  };
}

function classify(order) {
  if (order.app?.id === MATRIXIFY_SOURCE_APP_ID) return 'matrixify_imports';
  if (/pos/i.test(order.sourceName || '')) return 'pos_non_web';
  return 'native_online';
}

function hasAttribution(order) {
  const journey = order.customerJourneySummary;
  const visits = [journey?.firstVisit, journey?.lastVisit, ...(journey?.moments?.edges || []).map(edge => edge.node)].filter(Boolean);
  return {
    summary: Boolean(journey), ready: journey?.ready === true,
    moments: (journey?.moments?.edges?.length || 0) > 0,
    landing: visits.some(visit => Boolean(visit.landingPage)),
    referrer: visits.some(visit => Boolean(visit.referrerUrl)),
    utm: visits.some(visit => visit.utmParameters && Object.values(visit.utmParameters).some(Boolean))
  };
}

function aggregate(orders) {
  const total = orders.length;
  const count = key => orders.filter(order => hasAttribution(order)[key]).length;
  const metric = key => ({ count: count(key), percentage: total ? Number((100 * count(key) / total).toFixed(1)) : null });
  return { sample_size: total, customer_journey_summary: metric('summary'), ready_true: metric('ready'), at_least_one_moment: metric('moments'), landing_evidence: metric('landing'), referrer_evidence: metric('referrer'), any_utm_evidence: metric('utm') };
}

async function fetchOrders(ctx, selection, search, limit, queryClass) {
  const usesMomentPageSize = selection.includes('$momentFirst');
  const query = `query DiagnosticOrders($first: Int!, $query: String!${usesMomentPageSize ? ', $momentFirst: Int!' : ''}) {
    orders(first: $first, query: $query, sortKey: CREATED_AT) { nodes { ${selection} } }
  }`;
  const before = costs.get(queryClass)?.length || 0;
  const variables = { first: limit, query: search };
  if (usesMomentPageSize) variables.momentFirst = MOMENT_PAGE_SIZE;
  const data = await graphql(ctx.shop, ctx.token, query, variables, queryClass);
  const queryCost = costs.get(queryClass)?.[before] || null;
  return { orders: data.orders.nodes, queryCost };
}

function monthWindows(now) {
  const windows = [];
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const starts = [0, 3, 12, 24, 48, 84, 120];
  for (const monthsAgo of starts) {
    const to = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - monthsAgo, 1));
    const from = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() - 1, 1));
    windows.push({ label: monthsAgo === 0 ? 'current_month' : `${monthsAgo}_months_ago`, from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) });
  }
  return windows;
}

async function paginateJourney(ctx, selections, order) {
  const summary = order.customerJourneySummary;
  if (!selections.momentsPaginated || !summary?.moments) return { supported: false, reason: 'moments_not_verified_as_paginated_connection' };
  let pageInfo = summary.moments.pageInfo;
  let count = summary.moments.edges.length;
  let pages = 1;
  while (pageInfo?.hasNextPage && pages < 50) {
    const query = `query DiagnosticJourneyPage($id: ID!, $first: Int!, $after: String) {
      order: node(id: $id) { ... on Order { customerJourneySummary { moments(first: $first, after: $after) { edges { node { ${selections.visit} } } pageInfo { hasNextPage endCursor } } } } }
    }`;
    const data = await graphql(ctx.shop, ctx.token, query, { id: order.id, first: MOMENT_PAGE_SIZE, after: pageInfo.endCursor }, 'journey_continuation');
    const moments = data.order?.customerJourneySummary?.moments;
    if (!moments) break;
    count += moments.edges.length;
    pages += 1;
    pageInfo = moments.pageInfo;
  }
  return { supported: true, order_id: order.id, page_size: MOMENT_PAGE_SIZE, total_moments: count, pages, pagination_complete: pageInfo?.hasNextPage === false, safety_page_cap_reached: pages >= 50 };
}

async function run() {
  const { SHOPIFY_SHOP: shop, SHOPIFY_CLIENT_ID: clientId, SHOPIFY_CLIENT_SECRET: clientSecret } = process.env;
  const missing = ['SHOPIFY_SHOP', 'SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET'].filter(name => !process.env[name]);
  if (missing.length) {
    output.errors.push({ stage: 'configuration', code: 'missing_environment_variables', variables: missing });
    output.limitations.push('No live Shopify requests were made because required credentials were unavailable.');
    process.exitCode = 1;
    return;
  }

  let token;
  try { token = await authenticate(shop, clientId, clientSecret); }
  catch (error) { output.errors.push(safeError(error, 'authentication')); process.exitCode = 1; return; }
  const ctx = { shop, token };

  try {
    const scopes = await graphql(shop, token, `query DiagnosticAccessScopes { currentAppInstallation { accessScopes { handle } } }`, {}, 'access_scopes');
    output.access_scopes = scopes.currentAppInstallation.accessScopes.map(scope => scope.handle).sort();
  } catch (error) { output.errors.push(safeError(error, 'access_scopes')); }

  const names = ['QueryRoot', 'Order', 'OrderAttribution', 'CustomerJourneySummary', 'CustomerVisit', 'UTMParameters', 'ChannelInformation', 'App'];
  const types = {};
  for (const name of names) {
    try { types[name] = await inspectType(ctx, name); }
    catch (error) { output.errors.push(safeError(error, `schema:${name}`)); }
  }

  const momentsField = field(types.CustomerJourneySummary, 'moments');
  const momentConnectionName = namedType(momentsField?.type);
  if (momentConnectionName && !types[momentConnectionName]) types[momentConnectionName] = await inspectType(ctx, momentConnectionName);
  const connection = types[momentConnectionName];
  const nodesField = field(connection, 'nodes') || field(connection, 'edges');
  let momentNodeName = namedType(nodesField?.type);
  if (nodesField?.name === 'edges' && momentNodeName) {
    types[momentNodeName] = await inspectType(ctx, momentNodeName);
    momentNodeName = namedType(field(types[momentNodeName], 'node')?.type);
  }
  if (momentNodeName && !types[momentNodeName]) types[momentNodeName] = await inspectType(ctx, momentNodeName);
  const momentNodeType = types[momentNodeName];
  for (const possible of momentNodeType?.possibleTypes || []) {
    if (!types[possible.name]) types[possible.name] = await inspectType(ctx, possible.name);
  }
  const channelName = namedType(field(types.Order, 'channelInformation')?.type);
  if (channelName && !types[channelName]) types[channelName] = await inspectType(ctx, channelName);
  const attributionField = field(types.Order, 'attribution');
  const attributionName = namedType(attributionField?.type);
  if (attributionName && !types[attributionName]) types[attributionName] = await inspectType(ctx, attributionName);
  const attributionType = types[attributionName];
  for (const item of attributionType?.fields || []) {
    const relatedName = namedType(item.type);
    if (relatedName && !types[relatedName] && !['String', 'ID', 'Int', 'Float', 'Boolean'].includes(relatedName)) {
      try { types[relatedName] = await inspectType(ctx, relatedName); } catch (error) { output.errors.push(safeError(error, `schema:${relatedName}`)); }
    }
  }

  const definitionsField = field(types.QueryRoot, 'orderAttributionDefinitions');
  const definitionsReturnName = namedType(definitionsField?.type);
  if (definitionsReturnName && !types[definitionsReturnName]) types[definitionsReturnName] = await inspectType(ctx, definitionsReturnName);
  const definitionsReturnType = types[definitionsReturnName];
  let definitionTypeName = definitionsReturnName;
  let definitionPagination = 'not_a_connection';
  const definitionContainerField = field(definitionsReturnType, 'nodes') || field(definitionsReturnType, 'edges');
  if (definitionContainerField) {
    definitionPagination = 'connection';
    let containedName = namedType(definitionContainerField.type);
    if (definitionContainerField.name === 'edges') {
      if (containedName && !types[containedName]) types[containedName] = await inspectType(ctx, containedName);
      containedName = namedType(field(types[containedName], 'node')?.type);
    }
    definitionTypeName = containedName;
  }
  if (definitionTypeName && !types[definitionTypeName]) types[definitionTypeName] = await inspectType(ctx, definitionTypeName);
  const definitionType = types[definitionTypeName];
  for (const item of definitionType?.fields || []) {
    const relatedName = namedType(item.type);
    if (relatedName && !types[relatedName] && !['String', 'ID', 'Int', 'Float', 'Boolean'].includes(relatedName)) {
      try { types[relatedName] = await inspectType(ctx, relatedName); } catch (error) { output.errors.push(safeError(error, `schema:${relatedName}`)); }
    }
  }

  output.schema = {
    Order: pickFields(types.Order, TARGET_ORDER_FIELDS),
    OrderAttribution: attributionType ? { actual_type: attributionName, fields: Object.fromEntries((attributionType.fields || []).map(item => [item.name, fieldMetadata(item)])) } : { exists: false },
    CustomerJourneySummary: pickFields(types.CustomerJourneySummary, TARGET_SUMMARY_FIELDS),
    CustomerVisit: pickFields(types.CustomerVisit, TARGET_VISIT_FIELDS),
    UTMParameters: {
      fields: Object.fromEntries((types.UTMParameters?.fields || []).map(item => [item.name, fieldMetadata(item)])),
      requested_fields: pickFields(types.UTMParameters, TARGET_UTM_FIELDS),
      utm_id_fields: (types.UTMParameters?.fields || []).filter(item => /id/i.test(item.name)).map(item => item.name)
    },
    ChannelInformation: types[channelName] ? { actual_type: channelName, fields: Object.fromEntries((types[channelName].fields || []).map(item => [item.name, fieldMetadata(item)])) } : { exists: false },
    journey_moments: {
      return_type: typeRef(momentsField?.type), arguments: (momentsField?.args || []).map(arg => ({ name: arg.name, type: typeRef(arg.type), default_value: arg.defaultValue ?? null })),
      connection_type: momentConnectionName, node_type: momentNodeName,
      node_kind: momentNodeType?.kind || null, implementing_concrete_types: (momentNodeType?.possibleTypes || []).map(item => item.name),
      node_fields: Object.fromEntries((momentNodeType?.fields || []).map(item => [item.name, fieldMetadata(item)])),
      maximum_page_size: 'not_exposed_by_graphql_introspection'
    },
    concrete_moment_types: Object.fromEntries((momentNodeType?.possibleTypes || []).map(item => [item.name, { fields: Object.fromEntries((types[item.name]?.fields || []).map(f => [f.name, fieldMetadata(f)])) }]))
  };

  output.order_attribution_definitions = {
    query: definitionsField ? fieldMetadata(definitionsField) : { exists: false },
    return_type: definitionsField ? typeRef(definitionsField.type) : null,
    pagination_model: definitionPagination,
    definition_type: definitionTypeName || null,
    definition_fields: Object.fromEntries((definitionType?.fields || []).map(item => [item.name, fieldMetadata(item)])),
    items: [],
    query_attempted: false
  };
  if (definitionsField && definitionType) {
    const safeFields = safeSemanticSelection(definitionType, types);
    if (safeFields.length) {
      const args = new Set((definitionsField.args || []).map(arg => arg.name));
      const variableDefs = [];
      const callArgs = [];
      const variables = {};
      if (args.has('first')) {
        const firstArg = definitionsField.args.find(arg => arg.name === 'first');
        variableDefs.push(`$first: ${typeRef(firstArg.type)}`);
        callArgs.push('first: $first');
        variables.first = 50;
      }
      const selection = definitionPagination === 'connection'
        ? `${definitionContainerField.name} { ${definitionContainerField.name === 'edges' ? `node { ${safeFields.join(' ')} }` : safeFields.join(' ')} }${field(definitionsReturnType, 'pageInfo') ? ' pageInfo { hasNextPage endCursor }' : ''}`
        : safeFields.join(' ');
      const query = `query DiagnosticOrderAttributionDefinitions${variableDefs.length ? `(${variableDefs.join(', ')})` : ''} { orderAttributionDefinitions${callArgs.length ? `(${callArgs.join(', ')})` : ''} { ${selection} } }`;
      output.order_attribution_definitions.query_attempted = true;
      try {
        const data = await graphql(shop, token, query, variables, 'order_attribution_definitions');
        const result = data.orderAttributionDefinitions;
        const connectedItems = definitionContainerField?.name === 'edges'
          ? result?.edges?.map(edge => edge.node)
          : result?.nodes;
        output.order_attribution_definitions.items = safeAttribution(definitionPagination === 'connection' ? connectedItems : result) || [];
        if (definitionPagination === 'connection') output.order_attribution_definitions.page_info = result?.pageInfo || null;
      } catch (error) { output.errors.push(safeError(error, 'order_attribution_definitions')); }
    }
  }

  const selections = buildSelections(types);
  output.capabilities = {
    order_attribution_field_exists: Boolean(attributionField),
    order_journey_field_exists: Boolean(field(types.Order, 'customerJourneySummary')),
    moments_paginated_connection: selections.momentsPaginated,
    customer_visit_available: Boolean(types.CustomerVisit),
    protected_data_access_inference: 'not_inferred; use access_scopes and live field results',
    verified_sample_query_selection: selections.order
  };

  if (!field(types.Order, 'customerJourneySummary')) {
    output.limitations.push('Order.customerJourneySummary is absent, so journey sampling was not attempted.');
    return;
  }

  const windows = monthWindows(new Date());
  output.sample_methodology = {
    design: 'Seven deterministic one-month strata: current month and approximately 3, 12, 24, 48, 84, and 120 months ago.',
    orders_per_stratum: STRATUM_SIZE,
    maximum_orders: windows.length * STRATUM_SIZE,
    ordering: 'Oldest CREATED_AT order within each selected month', windows,
    journey_initial_page_size: MOMENT_PAGE_SIZE,
    note: 'Coverage is a bounded diagnostic sample, not a population estimate or full backfill.'
  };

  const sampled = [];
  for (const window of windows) {
    try {
      const result = await fetchOrders(ctx, selections.order, `created_at:>=${window.from} created_at:<${window.to}`, STRATUM_SIZE, 'historical_sampling');
      for (const order of result.orders) sampled.push({ ...order, _stratum: window.label, _queryCost: result.queryCost });
    } catch (error) { output.errors.push(safeError(error, `historical_sampling:${window.label}`)); }
  }

  const candidates = {
    recent_native_online: sampled.find(order => classify(order) === 'native_online'),
    recent_pos_non_web: sampled.find(order => classify(order) === 'pos_non_web'),
    guest_order: sampled.find(order => !order.customer),
    older_native_shopify: [...sampled].reverse().find(order => classify(order) === 'native_online'),
    matrixify_imported_woocommerce: sampled.find(order => classify(order) === 'matrixify_imports')
  };
  output.representative_orders = Object.entries(candidates).map(([category, order]) => order
    ? safeOrder(order, category, order._queryCost)
    : { sample_category: category, status: 'sample_unavailable' });

  const byClass = Object.groupBy ? Object.groupBy(sampled, classify) : sampled.reduce((acc, order) => ((acc[classify(order)] ||= []).push(order), acc), {});
  output.historical_coverage = {
    total_orders_sampled: sampled.length,
    by_classification: Object.fromEntries(Object.entries(byClass).map(([key, orders]) => [key, aggregate(orders)])),
    by_stratum: Object.fromEntries(windows.map(window => [window.label, aggregate(sampled.filter(order => order._stratum === window.label))])),
    earliest_sampled_native_order_with_journey_evidence: sampled
      .filter(order => classify(order) === 'native_online' && hasAttribution(order).summary)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]?.createdAt || null
  };

  const guest = candidates.guest_order;
  output.guest_order_behavior = guest ? { sample_found: true, ...aggregate([guest]) } : { sample_found: false, status: 'sample_unavailable' };
  const imported = byClass.matrixify_imports || [];
  output.matrixify_behavior = imported.length ? {
    sample_found: true, evidence_label: 'imported_order_source_metadata', ...aggregate(imported),
    warning: 'Source fields on imported orders are not classified as native Shopify acquisition evidence.'
  } : { sample_found: false, status: 'sample_unavailable' };

  const paginationCandidate = sampled.find(order => (order.customerJourneySummary?.moments?.edges?.length || 0) > 1)
    || sampled.find(order => order.customerJourneySummary?.moments);
  output.journey_pagination = paginationCandidate
    ? await paginateJourney(ctx, selections, paginationCandidate)
    : { status: 'sample_unavailable', reason: 'no_sampled_order_with_a_moments_connection' };

  output.bulk_operations = {
    schema_capability: field(types.Order, 'customerJourneySummary') ? 'journey_fields_exist_on_order' : 'journey_fields_absent',
    verdict: 'requires_live_bulk_query_test',
    test_launched: false,
    reason: 'Introspection cannot prove that Shopify Bulk Operations accepts a particular nested connection; this diagnostic deliberately does not launch an operation.'
  };

  const deprecatedChannelFields = (types[channelName]?.fields || [])
    .filter(item => item.isDeprecated)
    .map(item => ({ name: item.name, deprecation_reason: item.deprecationReason || null }));
  const observedValues = key => [...new Set(sampled.map(order => order[key]).filter(value => typeof value === 'string').map(sanitizeEvidence))];
  output.order_attribution_comparison = {
    evidence_basis: 'live_schema_descriptions_deprecations_and_bounded_order_samples',
    order_attribution: {
      represents: attributionField?.description || attributionType?.description || null,
      graphql_type: typeRef(attributionField?.type),
      observed_non_null_samples: sampled.filter(order => order.attribution != null).length,
      semantic_dimension: 'Shopify order attribution definition'
    },
    source_name: {
      represents: field(types.Order, 'sourceName')?.description || null,
      observed_values: observedValues('sourceName'),
      semantic_dimension: 'order source name'
    },
    order_app: {
      represents: field(types.Order, 'app')?.description || null,
      observed_app_ids: [...new Set(sampled.map(order => order.app?.id).filter(Boolean))],
      semantic_dimension: 'application associated with the order'
    },
    customer_journey_summary: {
      represents: field(types.Order, 'customerJourneySummary')?.description || types.CustomerJourneySummary?.description || null,
      observed_non_null_samples: sampled.filter(order => order.customerJourneySummary != null).length,
      semantic_dimension: 'customer journey and visit evidence'
    },
    deprecated_channel_information_fields: deprecatedChannelFields,
    replacement_assessment: {
      should_order_attribution_replace_channel_information: Boolean(attributionField) && deprecatedChannelFields.some(item => /Order\.attribution|OrderAttribution/.test(item.deprecation_reason || '')),
      basis: 'true only when the live schema exposes Order.attribution and a ChannelInformation deprecation reason explicitly recommends Order.attribution or OrderAttribution',
      keep_as_separate_semantic_dimensions: true,
      dimensions: ['order_attribution', 'source_name', 'order_app', 'customer_journey_summary']
    }
  };

  const nativeOrders = byClass.native_online || [];
  const readyFalse = nativeOrders.some(order => order.customerJourneySummary?.ready === false);
  const earliest = output.historical_coverage.earliest_sampled_native_order_with_journey_evidence;
  const persistedAttributionSelections = safeSemanticSelection(attributionType, types);
  const persistedAttributionRoots = new Set(persistedAttributionSelections.map(selection => selection.split(/[ {]/, 1)[0]));
  output.implementation_recommendation = {
    evidence_basis: 'live_introspection_and_bounded_samples_only',
    proposed_tables: field(types.Order, 'customerJourneySummary')
      ? ['shopify_data.order_acquisition', 'shopify_data.order_journey_moments'] : [],
    order_acquisition: {
      order_attribution_type: attributionName || null,
      persist_verified_fields: persistedAttributionSelections,
      field_metadata: Object.fromEntries((attributionType?.fields || [])
        .filter(item => persistedAttributionRoots.has(item.name))
        .map(item => [item.name, fieldMetadata(item)])),
      preserve_separate_dimensions: ['attribution', 'sourceName', 'app', 'customerJourneySummary'],
      channel_information_strategy: output.order_attribution_comparison.replacement_assessment.should_order_attribution_replace_channel_information
        ? 'Use Order.attribution instead of deprecated ChannelInformation fields for future ingestion.'
        : 'Do not replace ChannelInformation without an explicit live-schema replacement signal.'
    },
    order_journey_moments: {
      storage: 'shopify_data.order_journey_moments',
      keep_separate_from_order_acquisition: true
    },
    extraction_architecture: selections.momentsPaginated
      ? { recommendation: 'paginated_order_acquisition_plus_targeted_journey_continuation', reason: 'Moments is a verified paginated connection; initial order pages cannot prove completeness.' }
      : { recommendation: 'bounded_per_order_journey_extraction', reason: 'A paginated moments signature was not verified.' },
    backfill: {
      earliest_sampled_native_journey_evidence: earliest,
      reasonable_windows: windows.map(window => ({ from: window.from, to: window.to })),
      exclude_matrixify_from_native_journey_analytics: true,
      ready_false_strategy: readyFalse ? 'revisit_with_bounded_retry_until_ready_or_age_threshold' : 'retain_a_bounded_revisit_policy_even_though_no_ready_false_order_was_sampled'
    },
    incremental_sync: 'Refresh newly created and recently updated orders; revisit ready=false summaries; paginate moments independently until pageInfo.hasNextPage=false.',
    bulk_operations: 'Do not choose Bulk Operations until a separately approved minimal live bulk compatibility test succeeds.'
  };
}

try {
  await run();
} catch (error) {
  output.errors.push(safeError(error, 'unhandled'));
  output.limitations.push('The diagnostic stopped early after a safely redacted error.');
  process.exitCode = 1;
} finally {
  output.graphql_cost = Object.fromEntries(costs);
  // The only program output: one JSON document. Do not add debug logging.
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

export { sanitizeUrl, sanitizePath, typeRef };
