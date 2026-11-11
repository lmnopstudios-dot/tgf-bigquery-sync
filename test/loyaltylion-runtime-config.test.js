import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {loadLoyaltyConfig} from '../loyaltylion/runtime-config.js';
import {reviewedConfig} from './helpers/loyalty-fixture.js';
test('private config overrides stub; missing or invalid private files never fall back',()=>{
 assert.equal(loadLoyaltyConfig({}).access_status,'unverified');
 const dir=mkdtempSync(join(tmpdir(),'loyalty-config-'));
 try{
  const file=join(dir,'config.json'),c=reviewedConfig();
  writeFileSync(file,JSON.stringify(c),{mode:0o600});
  assert.equal(loadLoyaltyConfig({LOYALTYLION_CONFIG_PATH:file}).program_id,c.program_id);
  writeFileSync(file,'not json');
  assert.throws(()=>loadLoyaltyConfig({LOYALTYLION_CONFIG_PATH:file}),{code:'LOYALTY_RUNTIME_CONFIG_INVALID'});
  assert.throws(()=>loadLoyaltyConfig({LOYALTYLION_CONFIG_PATH:join(dir,'missing')}),{code:'LOYALTY_RUNTIME_CONFIG_INVALID'});
 }finally{rmSync(dir,{recursive:true,force:true});}
});
