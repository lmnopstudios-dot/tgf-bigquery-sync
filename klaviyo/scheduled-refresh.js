#!/usr/bin/env node
import {main as backfill} from './backfill.js';
import {londonMonth,previousMonth} from './months.js';

export function scheduledMonths(now=new Date()){const current=londonMonth(now);return [previousMonth(current),current];}
export async function main({now=new Date(),env=process.env}={}){const [from,through]=scheduledMonths(now);return backfill({env,args:[`--from=${from}`,`--through=${through}`,'--max-months=2']});}
if(import.meta.url===`file://${process.argv[1]}`)main().catch(error=>{console.error(JSON.stringify({status:'error',code:error.code||error.name,message:error.message}));process.exitCode=1;});
