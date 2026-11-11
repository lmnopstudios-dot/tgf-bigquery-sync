import {readFileSync} from 'node:fs';
import {validateConfig,fail} from './contracts.js';
// Read a private secret file at process startup; never log its contents or path.
export function loadLoyaltyConfig(env=process.env){
 try{
  const config=JSON.parse(readFileSync(env.LOYALTYLION_CONFIG_PATH||
    new URL('../config/loyaltylion-account.json',import.meta.url),'utf8'));
  return validateConfig(config);
 }catch{throw fail('LOYALTY_RUNTIME_CONFIG_INVALID');}
}
