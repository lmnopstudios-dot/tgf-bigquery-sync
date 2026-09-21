import { readFileSync } from 'node:fs';
import { assertAgentReadOnly, selectContext, validateCollection, validateKnowledgeItem } from '../oracle/knowledge.js';

const seeds = JSON.parse(readFileSync(new URL('../knowledge/seeds.json', import.meta.url), 'utf8'));

const evidence=[];let valid=true;
function check(name,fn){try{const detail=fn();evidence.push({name,passed:true,detail});}catch(error){valid=false;evidence.push({name,passed:false,error:error.message});}}
check('seed schema and provenance',()=>seeds.map(seed=>validateKnowledgeItem(seed.kind,seed).id));
check('unique seed IDs',()=>{const ids=seeds.map(x=>x.id);if(new Set(ids).size!==ids.length)throw new Error('duplicate seed ID');return ids.length;});
check('supersession and definition contradictions',()=>validateCollection(seeds));
check('seed implementation references',()=>{if(seeds.some(x=>!x.implementation_reference))throw new Error('missing implementation reference');return true;});
check('temporal and status retrieval',()=>{const selected=selectContext(seeds.map(x=>({...x,kind:x.kind})),{start_date:'2025-11-01',end_date:'2025-11-30'});if(selected.some(x=>['rejected','superseded'].includes(x.status)))throw new Error('unsafe status surfaced');return selected.length;});
check('/agent is read-only',assertAgentReadOnly);
console.log(JSON.stringify({validator:'knowledge',valid,evidence},null,2));
if(!valid)process.exitCode=1;
