const money=(value,currency)=>new Intl.NumberFormat('en-GB',{style:'currency',currency,maximumFractionDigits:0}).format(value);
const count=value=>new Intl.NumberFormat('en-GB').format(value);
export function renderInlineChart(chart){
  if(!chart||chart.version!==1||chart.kind!=='horizontal_bar'||!Array.isArray(chart.groups)||!chart.groups.length)return null;
  const figure=document.createElement('figure');figure.className='inline-chart';figure.tabIndex=0;figure.setAttribute('aria-labelledby',`${chart.id}-title`);
  const caption=document.createElement('figcaption'),title=document.createElement('strong'),meta=document.createElement('span');title.id=`${chart.id}-title`;title.textContent=chart.title;meta.textContent=`${chart.period} · ${chart.metric} · ${chart.source}`;caption.append(title,meta);figure.append(caption);
  for(const [groupIndex,group] of chart.groups.entries()){const section=document.createElement('section'),heading=document.createElement('h4');heading.textContent=group.label;section.append(heading);const max=Math.max(...group.items.map(x=>x.value),1),list=document.createElement('ol');list.className='inline-bars';list.id=`${chart.id}-group-${groupIndex}`;for(const [itemIndex,item] of group.items.entries()){const value=group.currency?money(item.value,group.currency):`${count(item.value)} customers`,row=document.createElement('li');row.setAttribute('aria-label',`${item.rank}. ${item.label}: ${value}`);if(itemIndex>=5)row.hidden=true;const label=document.createElement('span'),track=document.createElement('span'),bar=document.createElement('span'),shown=document.createElement('span');label.className='bar-label';label.textContent=item.label;track.className='bar-track';track.setAttribute('aria-hidden','true');bar.className='bar-fill';bar.style.width=`${Math.max(1,item.value/max*100)}%`;track.append(bar);shown.className='bar-value';shown.textContent=value;row.append(label,track,shown);list.append(row)}section.append(list);if(group.items.length>5){const toggle=document.createElement('button');toggle.type='button';toggle.className='chart-toggle secondary';toggle.textContent='Show top 10';toggle.setAttribute('aria-expanded','false');toggle.setAttribute('aria-controls',list.id);toggle.onclick=()=>{const expanded=toggle.getAttribute('aria-expanded')==='true';for(const row of [...list.children].slice(5))row.hidden=expanded;toggle.setAttribute('aria-expanded',String(!expanded));toggle.textContent=expanded?'Show top 10':'Show top 5'};section.append(toggle)}figure.append(section)}
  if(chart.coverage?.length){const note=document.createElement('p');note.className='chart-coverage';note.textContent=`Unknown shipping country retained in coverage: ${chart.coverage.map(x=>`${x.currency} ${count(x.unknown_country_orders)} orders · ${money(x.unknown_country_sales,x.currency)}`).join('; ')}. Excluded from named-country rankings.`;figure.append(note)}return figure;
}

/** Place at an explicit answer marker; retain the established safe append fallback. */
export function placeInlineChart(answerRoot,messageRoot,chart){
  const figure=renderInlineChart(chart);if(!figure)return null;
  return placeRenderedInlineChart(answerRoot,messageRoot,figure,chart?.placement);
}
export function placeRenderedInlineChart(answerRoot,messageRoot,figure,placement){
  const section=placement?.section_id;
  const marker=section&&/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(section)?answerRoot.querySelector(`[data-oracle-section=\"${section}\"]`):null;
  if(marker)marker.replaceWith(figure);else messageRoot.append(figure);
  return figure;
}
