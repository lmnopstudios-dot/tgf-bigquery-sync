import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
test('picker labels reflect actual namespaces and distinguish heuristics from persisted approval',async()=>{
 const {mappingProductLabel,mappingEvidenceLabel}=await import('../public/oracle/mapping-presentation.js');
 for(const [ref,label] of [['woo:ww:11737','WooCommerce WW'],['woo:usd:106660','WooCommerce USD'],['square:square:control','Square'],['shopify:shopify:gid://shopify/Product/10434361590087','Shopify']]){
  const product={source_product_ref:ref,title:'Powerslave',mapping_status:'resolved'};
  assert.ok(mappingProductLabel(product).startsWith(label+' — '));assert.ok(mappingProductLabel(product).includes(ref));
  assert.match(mappingEvidenceLabel(product),/Heuristic.*no persisted identity approval.*not report-ready/);
  assert.match(mappingEvidenceLabel({...product,explicit_mapping_status:'approved'}),/Persisted identity approval.*graph and classification/);
 }
 const app=fs.readFileSync(new URL('../public/oracle/app.js',import.meta.url),'utf8');
 assert.ok(app.includes('button.textContent=mappingProductLabel(product)'));
 assert.ok(app.includes('Selected: ${mappingProductLabel(product)}'));
 assert.ok(!app.includes('button.textContent=`Shopify —'));
 assert.match(app,/heuristic matches \(not persisted approvals\)/);
});


test('review guide preserves only the evidenced WW T-shirt outcome',()=>{
 const doc=fs.readFileSync(new URL('../docs/oracle/woo-review-and-source-receipts-383.md',import.meta.url),'utf8');
 const usd=doc.split('\n').find(l=>l.startsWith('| Woo USD | 108623 /'));
 const ww=doc.split('\n').find(l=>l.startsWith('| Woo WW | 80797 /'));
 assert.match(usd,/No persisted no-equivalent outcome demonstrated/);
 assert.doesNotMatch(usd,/Preserve the recorded no-equivalent outcome/);
 assert.match(ww,/Preserve the recorded no-equivalent outcome/);
});
