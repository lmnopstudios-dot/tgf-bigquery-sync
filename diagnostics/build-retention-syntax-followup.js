import {readFileSync,writeFileSync} from 'node:fs';
import {gzipSync} from 'node:zlib';
import {combinedValidationArtifact} from './build-retention-combined-validation.js';
export async function syntaxFollowupArtifact(){
 const {cases,project,snapshot,validation_source}=await combinedValidationArtifact();
 return {project,snapshot,cases,validation_source,runner_source:readFileSync(new URL('./validate-retention-syntax-followup.js',import.meta.url),'utf8')};
}
if(process.argv[1]===new URL(import.meta.url).pathname){writeFileSync(new URL('./retention-syntax-followup.json.gz',import.meta.url),gzipSync(JSON.stringify(await syntaxFollowupArtifact()),{mtime:0}));console.log('Built targeted syntax follow-up artifact: one planning check plus twelve corrected fixture executions.');}
