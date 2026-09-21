#!/usr/bin/env node
import { bqClient, readInput, seeds, setup, writeRecord } from './admin.js';
import { redactError } from '../oracle/ui-security.js';
async function main(){const [command,file]=process.argv.slice(2);const project=process.env.GOOGLE_PROJECT_ID||'gf-full-data';
  if(!['setup','seed','write'].includes(command))throw new Error('usage: node knowledge/cli.js setup|seed|write [record.json]');
  const client=bqClient();
  if(command==='setup')console.log(JSON.stringify(await setup(client,project),null,2));
  if(command==='seed'){const results=[];for(const item of seeds){try{results.push(await writeRecord(client,project,item));}catch(error){if(!/duplicate/i.test(error.message))throw error;}}console.log(JSON.stringify({seeded:results.length,results},null,2));}
  if(command==='write'){if(!file)throw new Error('write requires a JSON file');console.log(JSON.stringify(await writeRecord(client,project,await readInput(file)),null,2));}}
main().catch(error=>{console.error(`Knowledge administration failed: ${redactError(error)}`);process.exitCode=1;});
