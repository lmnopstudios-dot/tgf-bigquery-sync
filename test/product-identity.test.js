import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCanonicalProductGraph, consolidateSourceProducts, mapProductPair, normalizeRingSize, rowsAtGrain, selectBaseTitle, sourceProductRef } from '../oracle/product-identity.js';
import { normalizeProductTitle } from '../oracle/ecommerce-report-v2.js';

const line = (overrides = {}) => ({ source_platform:'woo', source_store:'ww', source_product_id:123, source_variant_id:0, title:'Bat Ring', quantity:1, sales:10, ...overrides });

test('Woo product ID consolidates historical titles, variations, and size options beneath one product', () => {
  const [product] = consolidateSourceProducts([
    line({ title:'Bat Ring', sale_date:'2020-01-01', option_name:'Ring Size', option_value:'R' }),
    line({ title:'Bat Ring – Sterling Silver', sale_date:'2021-01-01', source_variant_id:99, option_name:'size', option_value:'G' }),
    line({ title:'Bat Ring', sale_date:'2022-01-01' })
  ]);
  assert.equal(product.source_product_ref, 'woo:ww:123');
  assert.equal(product.title, 'Bat Ring');
  assert.equal(product.source_variants.length, 2);
  assert.deepEqual(product.options.map(x => x.normalized_ring_size), ['R','G']);
});

test('catalogue title wins; otherwise modal historical title with latest and lexical tie breaks is deterministic', () => {
  assert.deepEqual(selectBaseTitle([{ title:'Old', date:'2020' },{ title:'New', date:'2021' }], 'Catalogue'), { title:'Catalogue', method:'persisted_catalogue_title' });
  assert.equal(selectBaseTitle([{ title:'Old', date:'2020' },{ title:'New', date:'2021' }]).title, 'New');
  assert.equal(selectBaseTitle([{ title:'Bat', date:'2022' },{ title:'Bat' },{ title:'Other', line_count:1 }]).title, 'Bat');
});

test('ring size normalization is governed value normalization, never product-title stripping', () => {
  assert.equal(normalizeRingSize(' Size: R '), 'R');
  assert.equal(normalizeRingSize('k½'), 'K 1/2');
  assert.equal(normalizeRingSize('Bat Ring R'), null);
});

test('Shopify Online and POS share product namespace and variants remain children', () => {
  assert.equal(sourceProductRef({ source_platform:'shopify', source_store:'online', source_product_id:'456' }), sourceProductRef({ source_platform:'shopify', source_store:'pos', source_product_id:'456' }));
  const [product] = consolidateSourceProducts(['G','H','I','J'].map((size, i) => line({ source_platform:'shopify', source_store:i % 2 ? 'pos':'online', source_product_id:456, source_variant_id:i, variant_title:size })));
  assert.equal(product.source_variants.length, 4);
});

test('Square item is one product while variations remain children', () => {
  const [product] = consolidateSourceProducts(['G','H'].map((size, i) => line({ source_platform:'square', source_store:'square', source_product_id:'ITEM', source_variant_id:`VAR${i}`, variant_title:size })));
  assert.equal(product.source_product_ref, 'square:square:ITEM');
  assert.equal(product.source_variants.length, 2);
});

test('pairwise mapping applies SKU precedence, exact base title, and ignores global Square ambiguity', () => {
  const woo = [{ source_product_ref:'woo:ww:1', sku:'BAT-1', title:'Bat Ring' },{ source_product_ref:'woo:ww:2', title:'Skull Ring' }];
  const shopify = [{ source_product_ref:'shopify:shopify:9', sku:'BAT-1', title:'Renamed Bat' },{ source_product_ref:'shopify:shopify:10', title:'Skull Ring' }];
  const square = [{ source_product_ref:'square:square:a', title:'Bat Ring' },{ source_product_ref:'square:square:b', title:'Bat Ring' }];
  const edges = mapProductPair(woo, shopify, { normalizeTitle:normalizeProductTitle });
  assert.deepEqual(edges.map(x => x.mapping_method), ['exact_unique_sku','exact_unique_normalized_base_title']);
  assert.equal(mapProductPair(woo, shopify, { normalizeTitle:normalizeProductTitle }).length, 2);
  assert.equal(square.length, 2); // unrelated collisions were never supplied to or consulted by the pair.
});

test('Woo stores remain qualified and deterministic graph IDs are not normalized titles', () => {
  const products = [{ source_product_ref:'woo:ww:123' },{ source_product_ref:'woo:usd:123' },{ source_product_ref:'shopify:shopify:456' }];
  assert.notEqual(products[0].source_product_ref, products[1].source_product_ref);
  const edges = [{ left_ref:'woo:ww:123', right_ref:'shopify:shopify:456', mapping_method:'exact_unique_normalized_base_title', mapping_status:'resolved', provenance:'test' }];
  const graph = buildCanonicalProductGraph(products, edges);
  assert.equal(graph.length, 2);
  assert.match(graph.find(x => x.source_products.length === 2).canonical_product_ref, /^canonical:(?!bat ring)/);
});

test('product grain aggregates variants while variant grain preserves them and unresolved sales remain reportable', () => {
  const lines = [line({ source_variant_id:'G' }),line({ source_variant_id:'R', quantity:2, sales:20 }),line({ source_product_id:999, title:'Unresolved custom item', sales:5 })];
  assert.equal(rowsAtGrain(lines, 'product').find(x => x.product_ref === 'woo:ww:123').units, 3);
  assert.equal(rowsAtGrain(lines, 'variant_option').filter(x => x.product_ref === 'woo:ww:123').length, 2);
  assert.ok(rowsAtGrain(lines, 'product').some(x => x.product_ref === 'woo:ww:999' && x.product_sales === 5));
});
