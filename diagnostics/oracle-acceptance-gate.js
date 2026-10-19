// Offline release gate. Transport tests bind localhost and never contact providers.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const matrix=JSON.parse(readFileSync(new URL('../test/fixtures/oracle-acceptance-matrix.json',import.meta.url)));
const files=['test/oracle-acceptance-matrix.test.js',...matrix.regression_suites.map(s=>s.file)];
for(const file of files)readFileSync(new URL('../'+file,import.meta.url));
const result=spawnSync(process.execPath,['--test','--test-reporter=tap',...new Set(files)],{cwd:new URL('../',import.meta.url),encoding:'utf8',maxBuffer:64*1024*1024});
const log=(result.stdout||'')+(result.stderr||''),path=join(tmpdir(),'oracle-acceptance-gate.tap');writeFileSync(path,log);
const summary=log.split('\n').filter(line=>/^# (tests|pass|fail|cancelled|skipped|duration_ms) /.test(line));
console.log(summary.join('\n'));
for(const line of log.split('\n').filter(l=>l.includes('\"outcomes\"')))console.log(line.replace(/^#\s*/,''));console.log(`Acceptance log: ${path}`);
// Require a completed report, not just a zero shell status or mocked success.
if(result.error||result.signal||result.status!==0||!/^# fail 0$/m.test(log)||!/^# cancelled 0$/m.test(log)||/^not ok /m.test(log)){
  console.error('Oracle acceptance gate FAILED. Inspect the TAP log; interrupted suites are not passes.');process.exit(1);
}
console.log(`Oracle acceptance gate passed (${matrix.conversations.length} central conversations plus ${matrix.regression_suites.length} provider/delivery suites). Browser acceptance is a separate required check; deployed acceptance is still outstanding.`);
