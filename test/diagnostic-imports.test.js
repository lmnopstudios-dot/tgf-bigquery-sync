import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

for(const name of ['klaviyo-production','oracle-campaign-selection'])test(`${name} imports without a CLI entry point`,()=>{
 const url=new URL(`../diagnostics/${name}.js`,import.meta.url).href;
 const result=spawnSync(process.execPath,['--input-type=module','-e',`delete process.argv[1]; await import(${JSON.stringify(url)}); console.log('imported');`],{encoding:'utf8',timeout:5000});
 assert.equal(result.status,0,result.stderr);
 assert.equal(result.stdout.trim(),'imported');
});
