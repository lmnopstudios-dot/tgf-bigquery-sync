/** Governed product identity.  Product identity is deliberately independent of variant/option identity. */
export const PRODUCT_GRAIN = 'product';
export const VARIANT_GRAIN = 'variant_option';

export function sourceProductRef({ source_platform, source_store, source_product_id }) {
  const platform = String(source_platform || '').toLowerCase();
  const store = platform === 'shopify' ? 'shopify' : String(source_store || platform || 'unknown').toLowerCase();
  return `${platform}:${store}:${String(source_product_id ?? 'unknown')}`;
}

export function selectBaseTitle(lines = [], catalogueTitle = null) {
  if (String(catalogueTitle || '').trim()) return { title: String(catalogueTitle).trim(), method: 'persisted_catalogue_title' };
  const usable = lines.filter(line => String(line.title || '').trim());
  if (!usable.length) return { title: null, method: 'unavailable' };
  const groups = new Map();
  for (const [index, line] of usable.entries()) {
    const title = String(line.title).trim();
    const key = title.normalize('NFKC').toLocaleLowerCase('en').replace(/\s+/g, ' ');
    const entry = groups.get(key) || { title, count: 0, latest: '', lastIndex: -1 };
    entry.count += Number(line.line_count || 1);
    const date = String(line.sale_date || line.date || '');
    if (date > entry.latest || (date === entry.latest && index > entry.lastIndex)) Object.assign(entry, { title, latest: date, lastIndex: index });
    groups.set(key, entry);
  }
  const winner = [...groups.values()].sort((a, b) => b.count - a.count || b.latest.localeCompare(a.latest) || a.title.localeCompare(b.title))[0];
  return { title: winner.title, method: 'modal_historical_title_latest_tiebreak', evidence_count: winner.count };
}

export function normalizeRingSize(value) {
  const text = String(value ?? '').normalize('NFKC').trim().toUpperCase().replaceAll('⁄', '/').replace(/^SIZE\s*[:=-]?\s*/, '').replace(/\s+/g, ' ');
  // A governed value, not a product-title parser. UK alpha sizes and half sizes only.
  return /^(?:[A-Z](?:\s*(?:1\/2|½))?)$/.test(text) ? text.replace(/^([A-Z])\s*1\/2$/, '$1 1/2').replace('½', ' 1/2').replace(/\s+/g, ' ') : null;
}

export function consolidateSourceProducts(lines, { catalogueTitles = new Map() } = {}) {
  const grouped = new Map();
  for (const line of lines) {
    const source_product_ref = sourceProductRef(line);
    const product = grouped.get(source_product_ref) || { source_product_ref, source_platform: line.source_platform, source_store: line.source_platform === 'shopify' ? 'shopify' : line.source_store, source_product_id: String(line.source_product_id ?? 'unknown'), channels: new Set(), lines: [], variants: new Map(), options: [] };
    if (line.channel || line.source_store) product.channels.add(line.channel || line.source_store);
    product.lines.push(line);
    if (line.source_variant_id != null) product.variants.set(String(line.source_variant_id), line.variant_title ?? null);
    if (line.option_name || line.option_value) product.options.push({ name: line.option_name ?? null, value: line.option_value ?? null, normalized_ring_size: /(?:ring\s*)?size/i.test(String(line.option_name || '')) ? normalizeRingSize(line.option_value) : null });
    grouped.set(source_product_ref, product);
  }
  return [...grouped.values()].map(product => ({ ...product, channels:[...product.channels].sort(), ...selectBaseTitle(product.lines, catalogueTitles.get(product.source_product_ref)), source_variants: [...product.variants].map(([source_variant_id, title]) => ({ source_variant_id, title })) }));
}

const uniqueIndex = (products, key) => {
  const index = new Map();
  for (const product of products) {
    const value = key(product);
    if (!value) continue;
    if (!index.has(value)) index.set(value, []);
    index.get(value).push(product);
  }
  return index;
};

/** Resolve one source pair only; a collision in an unrelated source can never poison this edge. */
export function mapProductPair(left, right, { normalizeTitle, explicitMappings = [] } = {}) {
  normalizeTitle ||= value => String(value || '').normalize('NFKC').toLocaleLowerCase('en').trim().replace(/\s+/g, ' ');
  const rightSku = uniqueIndex(right, p => String(p.sku || '').trim().toUpperCase() || null);
  const leftSku = uniqueIndex(left, p => String(p.sku || '').trim().toUpperCase() || null);
  const norm = p => normalizeTitle(p.title || p.base_title || '') || null;
  const rightTitle = uniqueIndex(right, norm), leftTitle = uniqueIndex(left, norm);
  const edges = [], usedLeft = new Set(), usedRight = new Set();
  const add = (l, r, mapping_method, provenance = 'deterministic_product_identity') => {
    if (usedLeft.has(l.source_product_ref) || usedRight.has(r.source_product_ref)) return;
    edges.push({ left_ref: l.source_product_ref, right_ref: r.source_product_ref, mapping_method, mapping_status: 'resolved', provenance });
    usedLeft.add(l.source_product_ref); usedRight.add(r.source_product_ref);
  };
  for (const edge of explicitMappings) {
    const l = left.find(p => p.source_product_ref === edge.left_ref), r = right.find(p => p.source_product_ref === edge.right_ref);
    if (l && r) add(l, r, 'explicit_governed_mapping', edge.provenance || 'governed_mapping');
  }
  for (const l of left) {
    const sku = String(l.sku || '').trim().toUpperCase();
    if (sku && leftSku.get(sku)?.length === 1 && rightSku.get(sku)?.length === 1) add(l, rightSku.get(sku)[0], 'exact_unique_sku');
  }
  for (const l of left) {
    const title = norm(l);
    if (title && leftTitle.get(title)?.length === 1 && rightTitle.get(title)?.length === 1) add(l, rightTitle.get(title)[0], 'exact_unique_normalized_base_title');
  }
  return edges;
}

export function buildCanonicalProductGraph(products, edges) {
  const parent = new Map(products.map(p => [p.source_product_ref, p.source_product_ref]));
  const find = x => { const p = parent.get(x); if (p !== x) parent.set(x, find(p)); return parent.get(x); };
  const union = (a, b) => { const ar = find(a), br = find(b); if (ar !== br) parent.set(br, ar < br ? ar : br), parent.set(ar, ar < br ? ar : br); };
  for (const edge of edges.filter(e => e.mapping_status === 'resolved')) if (parent.has(edge.left_ref) && parent.has(edge.right_ref)) union(edge.left_ref, edge.right_ref);
  const groups = new Map();
  for (const product of products) { const root = find(product.source_product_ref); if (!groups.has(root)) groups.set(root, []); groups.get(root).push(product.source_product_ref); }
  return [...groups.values()].map(members => ({ canonical_product_ref: `canonical:${members.slice().sort()[0]}`, source_products: members.slice().sort(), edges: edges.filter(e => members.includes(e.left_ref) && members.includes(e.right_ref)) }));
}

export function rowsAtGrain(lines, grain = PRODUCT_GRAIN) {
  if (![PRODUCT_GRAIN, VARIANT_GRAIN].includes(grain)) throw new Error(`Unsupported product grain: ${grain}`);
  const rows = new Map();
  for (const line of lines) {
    const product = line.canonical_product_ref || sourceProductRef(line);
    const variant = String(line.source_variant_id ?? line.option_value ?? 'unresolved');
    const key = grain === PRODUCT_GRAIN ? product : `${product}:${variant}`;
    const row = rows.get(key) || { product_ref: product, ...(grain === VARIANT_GRAIN ? { variant_ref: variant } : {}), units: 0, product_sales: 0 };
    row.units += Number(line.units || line.quantity || 0); row.product_sales += Number(line.product_sales || line.sales || 0); rows.set(key, row);
  }
  return [...rows.values()];
}
