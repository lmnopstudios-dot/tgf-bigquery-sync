// Explicit native source preview. No warehouse, export, source mutation or collector.
import {createKpiConversionReader,kpiConversionRange,kpiConversionRows,KPI_CONVERSION_BOUNDS,KPI_CONVERSION_DEFINITION} from '../oracle/kpi-conversion.js';
import {validDay,londonDay} from '../public/oracle/kpi-intent.js';
const args=process.argv.slice(2),execute=args.includes('--execute-read-only'),dates=args.filter(a=>/^\d{4}-\d{2}-\d{2}$/.test(a));
if(args.some(a=>a!=='--execute-read-only'&&!dates.includes(a))||dates.length!==2||!dates.every(validDay)||dates[0]>dates[1]||dates[1]>=londonDay(Date.now()))throw Error('Use START END [--execute-read-only], completed London dates only');
const periods=[{id:'selected',label:'Explicit validation window',start_date:dates[0],end_date:dates[1]}],now=Date.now();
console.log(JSON.stringify({read_only:true,warehouse_writes:false,source_reads:execute,definition:KPI_CONVERSION_DEFINITION,requested:periods[0],effective_range:kpiConversionRange(periods,now),bounds:KPI_CONVERSION_BOUNDS}));
if(execute){
 const started=Date.now(),timer=setInterval(()=>console.log(JSON.stringify({read_only:true,phase:'native_conversion_read',elapsed_seconds:Math.floor((Date.now()-started)/1000)})),15000);
 try{
  const source=await createKpiConversionReader()({periods,scope:{channel:'online',currency:null,geography:'all'},now,signal:AbortSignal.timeout(65000),deadlineAt:Date.now()+60000}),result=kpiConversionRows(source,periods);
  console.log(JSON.stringify({read_only:true,warehouse_writes:false,api_attempts:source.api_attempts,results:result.rows,unknown_geography:result.unknown,supported_populations:result.rows.filter(r=>r.value!=null).length},null,2));
  if(!result.rows.some(r=>r.value!=null))process.exitCode=1;
 }catch(error){console.log(JSON.stringify({read_only:true,warehouse_writes:false,status:'failed',code:['EVIDENCE_SCOPE_MISMATCH','KPI_CONVERSION_BOUND','LEASE_NOT_OWNED'].includes(error.code)?error.code:'KPI_CONVERSION_UNAVAILABLE'}));process.exitCode=1;}
 finally{clearInterval(timer);}
}
