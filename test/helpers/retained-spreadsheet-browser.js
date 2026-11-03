import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {createMemoryExportStore} from '../../oracle/product-priority-storage.js';
import {acceptanceServer} from './oracle-acceptance.js';

// Real composer, durable worker, authenticated download and page reload.
// Provider quantities are fixtures; this does not claim live Shopify coverage.
export async function verifyRetainedSpreadsheetBrowser(browser){
 const f={calls:[],exportStore:createMemoryExportStore()};
 f.baseline=async(_message,{analysisContext})=>{
  f.calls.push('read');
  return {analysis_context:analysisContext,answer:'Alphabones: Soho 4, online 0. Observation 2026-11-03T11:14:31Z. Coverage incomplete.',tools:[],partial:true,evidence:{kind:'current_stock',subject:'current_stock',entity_query:'Alphabones',stock_scope:analysisContext.stock_scope,complete:false,as_of:'2026-11-03T11:14:31Z',location_coverage:{resolved:[{id:'soho',name:'Soho'},{id:'online',name:'Online Ready to Ship'}]},products:[{title:'Alphabones',variants:[{title:'N',sku:'ALPHA-N',locations:[{location_id:'soho',location_name:'Soho',available:4,observed_at:'2026-11-03T11:14:31Z'},{location_id:'online',location_name:'Online Ready to Ship',available:0,observed_at:'2026-11-03T11:14:31Z'}]}]}]}};
 };
 const h=await acceptanceServer(f,{durable:true});
 try{for(const width of [1280,390]){
  const page=await browser.newPage({viewport:{width,height:900}});
  try{
   await page.goto(h.origin+'/oracle/');await page.locator('#password').fill('fixture');await page.locator('#login-form button').click();await page.locator('#app').waitFor({state:'visible'});
   for(const message of ['Show current available stock for Alphabones, broken down by every variant and size, at Kings Cross, Shoreditch, Soho and Online Ready to Ship.  Exclude workshops. Show one row per variant and one column per location. Keep zero stock distinct from unavailable quantities.','can i have this as a spreadsheet']){
    await page.locator('#message').fill(message);await page.locator('#send').click();await page.waitForFunction(()=>!document.querySelector('#send').disabled);
   }
   const count=f.calls.length;assert.equal(count,width===1280?1:2);
   const link=page.locator('a[href*="/api/oracle/exports/"]').last();await link.waitFor();const response=await page.request.get(h.origin+await link.getAttribute('href'));assert.equal(response.status(),200);
   const wb=new ExcelJS.Workbook();await wb.xlsx.load(await response.body());assert.equal(wb.getWorksheet('Inventory').getCell('D2').value,4);assert.equal(wb.getWorksheet('Inventory').getCell('E2').value,0);
   assert.match(JSON.stringify(wb.getWorksheet('Source notes').getSheetValues()),/2026-11-03T11:14:31Z/);
   await page.reload();await page.waitForFunction(()=>!document.querySelector('#send').disabled&&document.querySelector('.analytical-answer'));assert.equal(f.calls.length,count);assert.match(await page.locator('.analytical-answer').last().innerText(),/No data was refreshed/);
  }finally{await page.close();}
 }}finally{await h.close();}
}
