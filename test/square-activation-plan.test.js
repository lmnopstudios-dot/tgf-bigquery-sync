import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {squareActivationPlan} from '../diagnostics/square-activation-plan.js';
import {squareExtensionConfiguration,squareExtensionGuard} from '../oracle/square-reporting-extension.js';
test('approved marker INSERT has an explicit one-row source before WHERE; source-free SELECT is invalid GoogleSQL',()=>{
 const p=squareActivationPlan(),insert=p.proposed_sql.slice(p.proposed_sql.indexOf('INSERT INTO'),p.proposed_sql.indexOf('\nASSERT ',p.proposed_sql.indexOf('INSERT INTO')));
 assert.match(insert,/SELECT [^\n]+\nFROM UNNEST\(\[1\]\) AS review_seed\nWHERE NOT EXISTS/);assert.doesNotMatch(insert,/SELECT [^\n]+\nWHERE/);
 assert.equal(p.proposed_record.base_snapshot,'history-20261022-billing-v3');assert.equal(p.activated,false);assert.equal(p.approval_required,true);
 const guard=squareExtensionGuard('gf-full-data',{dataset:'customer_identity',snapshot:p.proposed_record.base_snapshot},squareExtensionConfiguration(p.render_settings));assert.equal(p.post_approval_guard_read,`SELECT ${guard} AS reviewed_extension_matches`);assert.ok(p.proposed_sql.includes(`ASSERT ${guard}`));
 assert.doesNotMatch(p.proposed_sql,/UPDATE |DELETE |MERGE |identity_order_links/);
});
test('published review SQL matches the generated proposal exactly',()=>{
 assert.equal(readFileSync(new URL('../docs/square-reviewed-extension-proposal.sql',import.meta.url),'utf8'),squareActivationPlan().proposed_sql+'\n');
});
