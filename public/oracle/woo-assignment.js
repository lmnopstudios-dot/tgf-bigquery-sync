const isWoo=ref=>/^woo:(ww|usd):[^:]+$/.test(String(ref||''));
const isParent=ref=>/^shopify:shopify:(?:gid:\/\/shopify\/Product\/)?\d+$/.test(String(ref||''));
const currentTarget=item=>item.active_family_assignment?.shopify_parent_ref||[item.active_identity_mapping?.left_ref,item.active_identity_mapping?.right_ref].find(isParent)||null;
const assigned=item=>['active_identity','active_reporting_family'].includes(item.resolution_status);
const editable=item=>!assigned(item)&&item.resolution_status!=='no_equivalent';
const saved=row=>['saved','already_applied'].includes(row.result?.status);
export function prepareWooBatch(rows,action){
 if(!['family','identity'].includes(action)||!rows.length||rows.length>8)throw Error('Select 1–8 Woo products and a relationship.');
 const refs=new Set();
 return rows.map(row=>{
  const ref=row.item.historical_product.source_product_ref;
  if(!isWoo(ref)||refs.has(ref)||!editable(row.item))throw Error('Only distinct, unassigned Woo products may be saved here.');
  refs.add(ref);
  if(!isParent(row.target?.source_product_ref)||row.preview?.selected_product?.source_product_ref!==row.target.source_product_ref||row.preview?.[action+'_preview']?.allowed!==true)throw Error('Each selected product needs an allowed preview for this relationship.');
  // The existing bulk API revalidates each row against current governance after
  // earlier rows commit. Do not carry a global-state token that those commits stale.
  return {request_id:crypto.randomUUID(),action,source_ref:ref,shopify_parent_ref:row.target.source_product_ref,note:null};
 });
}

export function createWooAssignmentPanel({api,root=document,storage=localStorage,confirm=message=>window.confirm(message)}){
 const $=id=>root.querySelector('#'+id),panel=$('woo-assignment-panel'),dialog=$('woo-target-dialog');
 const key='oracle-woo-assignment-batch-v1';
 let rows=[],page=1,pages=1,generation=0,busy=false,pending=null,searchRows=[],previewing=0;
 const text=(tag,value,className)=>{const n=document.createElement(tag);n.textContent=value;if(className)n.className=className;return n;};
 const selected=()=>rows.filter(r=>r.selected),action=()=>$('woo-action').value;
 function controls(){
  for(const row of rows){
   const locked=busy||!!pending||!editable(row.item)||saved(row);
   if(row.checkbox)row.checkbox.disabled=locked;
   if(row.select)row.select.disabled=locked;
   if(row.find)row.find.disabled=locked;
  }
  const selectPage=$('woo-products').querySelector('.woo-select-page input');if(selectPage)selectPage.disabled=busy||!!pending;
  const n=selected().length;$('woo-selection-count').textContent=n+' selected';
  $('woo-save').disabled=busy||!!pending||previewing>0||!n||n>8||selected().some(r=>r.preview?.[action()+'_preview']?.allowed!==true);
  $('woo-shared-target').disabled=busy||!!pending||!n||n>8;
  $('woo-action').disabled=busy||!!pending;
  for(const id of ['woo-load','woo-store','woo-status','woo-search'])$(id).disabled=busy;
  $('woo-recover').hidden=!pending;
 }
 function savePending(value){pending=value;if(value)storage.setItem(key,JSON.stringify(value));else storage.removeItem(key);controls();}
 function statusFor(row){
  if(row.result)return `${row.result.status.replaceAll('_',' ')}${row.result.error?': '+row.result.error:''}`;
  if(assigned(row.item))return row.item.resolution_status==='active_reporting_family'?'Saved reporting family':'Saved identity approval';
  if(row.item.resolution_status==='no_equivalent')return 'Saved: no equivalent — preserved';
  if(row.loading)return 'Checking current graph and family rules…';
  if(row.error)return row.error;
  if(row.preview){const p=row.preview[action()+'_preview'];return p?.allowed?'Ready for review':`Blocked: ${p?.reason||'current rules reject this relationship'}`;}
  return row.item.historical_product.mapping_status==='resolved'?'Title/SKU suggestion only — not a saved approval':'Choose a Shopify target';
 }
 function paintStatus(row){row.status.textContent=statusFor(row);row.status.className='woo-row-status '+(row.preview?.[action()+'_preview']?.allowed?'allowed':row.error||row.result?.error?'blocked':'');controls();}
 async function preview(row){
  const target=row.target?.source_product_ref,stamp=++row.revision;
  row.preview=null;row.error=null;
  if(!target){paintStatus(row);return;}
  row.loading=true;previewing++;paintStatus(row);
  try{
   const params=new URLSearchParams({candidate_id:row.item.candidate.candidate_id,source_ref:row.item.historical_product.source_product_ref,selected_ref:target});
   const p=await api('/product-mappings/choice-preview?'+params);
   if(stamp===row.revision){if(p.selected_product?.source_product_ref!==target)throw Error('Preview target changed; choose again.');row.preview=p;}
  }catch(e){if(stamp===row.revision)row.error='Preview unavailable: '+e.message;}
  finally{previewing--;if(stamp===row.revision){row.loading=false;paintStatus(row);}controls();}
 }
 function chooseTarget(row,target){
  if(busy||pending||!editable(row.item)||saved(row))return;
  row.target=target;row.result=null;
  if(![...row.select.options].some(o=>o.value===target.source_product_ref))row.select.add(new Option(target.title+' · '+target.source_product_ref,target.source_product_ref));
  row.select.value=target.source_product_ref;
  row.targets.set(target.source_product_ref,target);preview(row);
 }
 function openSearch(chosen){
  if(!chosen.length||busy||pending)return;searchRows=chosen;
  $('woo-target-context').textContent=`Apply one Shopify product to ${chosen.length} selected Woo row${chosen.length===1?'':'s'}. This chooses targets only; nothing is saved yet.`;
  $('woo-target-query').value=chosen.length===1?chosen[0].item.historical_product.title||'':'';
  $('woo-target-results').replaceChildren();dialog.showModal();$('woo-target-query').focus();
 }
 function render(){
  $('woo-products').replaceChildren();
  const toolbar=document.createElement('label');toolbar.className='woo-select-page';const all=document.createElement('input');all.type='checkbox';all.setAttribute('aria-label','Select unassigned products on this page');toolbar.append(all,text('span','Select unassigned on this page (maximum 8)'));all.disabled=!!pending;
  all.onchange=()=>{let remaining=8;for(const row of rows){row.selected=all.checked&&editable(row.item)&&!saved(row)&&remaining-->0;row.checkbox.checked=row.selected;}controls();};
  $('woo-products').append(toolbar);
  for(const row of rows){
   const product=row.item.historical_product,card=document.createElement('article');card.className='woo-assignment-row';card.dataset.sourceRef=product.source_product_ref;
   const label=document.createElement('label');label.className='woo-product-label';row.checkbox=document.createElement('input');row.checkbox.type='checkbox';row.checkbox.checked=row.selected;row.checkbox.setAttribute('aria-label','Select '+product.source_product_ref);row.checkbox.disabled=!editable(row.item)||!!pending;
   row.checkbox.onchange=()=>{if(row.checkbox.checked&&selected().length>=8){row.checkbox.checked=false;$('woo-batch-status').textContent='Save up to 8 rows at a time.';}row.selected=row.checkbox.checked;controls();};
   const info=document.createElement('div');info.append(text('strong',product.title||'Untitled Woo product'),text('small',(product.source_store==='ww'?'Woo WW':'Woo USD')+' · '+product.source_product_ref),text('small',`${product.line_items||0} recorded lines${product.sku?' · SKU '+product.sku:''}`));label.append(row.checkbox,info);
   const targetBox=document.createElement('div');targetBox.className='woo-target-box';
   row.targets=new Map((row.item.shopify_suggestions||[]).filter(p=>isParent(p.source_product_ref)).map(p=>[p.source_product_ref,p]));
   if(assigned(row.item)){targetBox.append(text('strong','Current saved target'),text('small',currentTarget(row.item)||'Inspect identity history for endpoints'));}
   else if(editable(row.item)){
    row.select=document.createElement('select');row.select.setAttribute('aria-label','Shopify target for '+product.source_product_ref);row.select.add(new Option('Choose a Shopify suggestion…',''));for(const p of row.targets.values())row.select.add(new Option(p.title+' · '+p.source_product_id,p.source_product_ref));if(row.target){row.targets.set(row.target.source_product_ref,row.target);if(![...row.select.options].some(o=>o.value===row.target.source_product_ref))row.select.add(new Option(row.target.title+' · '+row.target.source_product_ref,row.target.source_product_ref));row.select.value=row.target.source_product_ref;}row.select.disabled=!!pending;
    row.select.onchange=()=>{if(!row.select.value){row.target=null;row.preview=null;row.revision++;paintStatus(row);}else chooseTarget(row,row.targets.get(row.select.value));};
    const find=text('button','Search Shopify','secondary');row.find=find;find.type='button';find.disabled=!!pending;find.onclick=()=>openSearch([row]);targetBox.append(row.select,find,text('small','Suggestions require your review. Old and new designs remain separate.'));
   }
   row.status=text('p',statusFor(row),'woo-row-status');card.append(label,targetBox,row.status);$('woo-products').append(card);
  }
  if(!rows.length)$('woo-products').append(text('p','No Woo products match these filters. Try All Woo products or a different search.','empty'));
  const pager=$('woo-pagination');pager.replaceChildren();for(const [label,step]of [['Previous',-1],['Next',1]]){const b=text('button',label,'secondary');b.type='button';b.disabled=busy||(step<0?page<=1:page>=pages);b.onclick=()=>{page+=step;load();};pager.append(b);}pager.append(text('span',`Page ${page} of ${pages}`));controls();
 }
 async function load({reset=false}={}){
  if(busy)return;if(reset)page=1;const g=++generation;
  $('woo-summary').textContent='Loading Woo products, including unsaved title/SKU matches…';
  try{
   const params=new URLSearchParams({view:'woo_assignment',source:$('woo-store').value,assignment_status:$('woo-status').value,search:$('woo-search').value,sort:'title',page:String(page),page_size:'25'});
   const data=await api('/product-mappings?'+params);if(g!==generation)return;
   rows=(data.items||[]).filter(item=>isWoo(item.historical_product?.source_product_ref)).map(item=>({item,selected:false,target:null,preview:null,revision:0}));
   pages=data.pagination.total_pages;page=data.pagination.page;
   $('woo-summary').textContent=`${data.pagination.total_items} matching historical Woo products · ${rows.length} shown. Saved approvals and no-equivalent decisions are separate from suggestions.`;
   render();
  }catch(e){if(g===generation){$('woo-summary').textContent='Could not load Woo products: '+e.message;$('woo-products').replaceChildren();rows=[];controls();}}
 }
 function applyResults(result){
  for(const r of result.results||[]){const ref=r.source_ref||pending?.decisions?.[r.index]?.source_ref;const row=rows.find(x=>x.item.historical_product.source_product_ref===ref);if(row){row.result=r;row.selected=false;row.checkbox.checked=false;if(['saved','already_applied'].includes(r.status)){row.checkbox.disabled=true;row.select&&(row.select.disabled=true);}paintStatus(row);}}
  const detail=(result.results||[]).map(r=>`${r.source_ref||pending?.decisions?.[r.index]?.source_ref||'Row '+(r.index+1)}: ${r.status.replaceAll('_',' ')}${r.error?' — '+r.error:''}`).join('\n');
  $('woo-batch-status').textContent=`Batch ${result.operation_id}: ${result.succeeded||0} saved/already applied · ${result.blocked||0} blocked · ${result.failed||0} failed · ${result.pending||0} pending.\n${detail}`;
  if(result.status==='complete'||result.results?.length===pending?.decisions?.length&&result.results.every(r=>r.status!=='submitted'))savePending(null);else controls();
 }
 async function recover(){
  if(!pending)return;try{applyResults(await api('/product-mappings/bulk-review/'+encodeURIComponent(pending.operation_id)));}catch(e){$('woo-batch-status').textContent='Batch outcome not confirmed. Check this same batch again; it has not been resubmitted. '+e.message;}controls();
 }
 $('woo-target-form').onsubmit=async event=>{
  event.preventDefault();const g=++generation,container=$('woo-target-results');container.replaceChildren(text('p','Searching Shopify…'));
  try{const data=await api('/product-mappings/search?'+new URLSearchParams({q:$('woo-target-query').value,sources:'shopify',limit:'25'}));if(g!==generation)return;
   container.replaceChildren();for(const p of (data.items||[]).filter(p=>isParent(p.source_product_ref))){const b=text('button',p.title+' · '+p.source_product_ref,'picker-result secondary');b.type='button';b.onclick=()=>{for(const row of searchRows)chooseTarget(row,p);dialog.close();};container.append(b);}if(!container.children.length)container.append(text('p','No matching Shopify parent products. Try another title or product ID.'));
  }catch(e){if(g===generation)container.replaceChildren(text('p','Search failed: '+e.message));}
 };
 $('woo-target-close').onclick=()=>{generation++;dialog.close();};dialog.addEventListener('cancel',()=>generation++);
 $('woo-shared-target').onclick=()=>openSearch(selected());
 $('woo-action').onchange=()=>{for(const row of rows)paintStatus(row);};
 $('woo-load').onclick=()=>load({reset:true});for(const id of ['woo-store','woo-status'])$(id).onchange=()=>load({reset:true});
 $('woo-search').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();load({reset:true});}};
 $('woo-recover').onclick=recover;
 $('woo-save').onclick=async()=>{
  let decisions;try{decisions=prepareWooBatch(selected(),action());}catch(e){$('woo-batch-status').textContent=e.message;return;}
  const details=selected().map(r=>`${r.item.historical_product.source_product_ref} → ${r.target.title} (${r.target.source_product_ref})`).join('\n');
  if(!confirm(`Save ${decisions.length} ${action()==='family'?'reporting-family assignments':'identity mappings'}?\n\n${details}\n\nEvery row is revalidated independently. Other rows are retained if one is blocked.`))return;
  busy=true;savePending({operation_id:crypto.randomUUID(),decisions});render();
  try{applyResults(await api('/product-mappings/bulk-review',{method:'POST',body:JSON.stringify(pending)}));}catch(e){$('woo-batch-status').textContent='Save response interrupted. Checking the same batch; no automatic resubmission. '+e.message;await recover();}finally{busy=false;controls();}
 };
 try{const raw=storage.getItem(key);if(raw){const p=JSON.parse(raw);if(typeof p.operation_id==='string'&&Array.isArray(p.decisions)&&p.decisions.length<=8)pending=p;}}catch{}
 return {show:async()=>{panel.hidden=false;await load();if(pending)await recover();},hide:()=>{generation++;panel.hidden=true;},load};
}
