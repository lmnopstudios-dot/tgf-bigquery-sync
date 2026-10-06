const money=(value,currency)=>new Intl.NumberFormat('en-GB',{style:'currency',currency,maximumFractionDigits:0}).format(value);
const count=value=>new Intl.NumberFormat('en-GB',{maximumFractionDigits:2}).format(value);
export function renderInlineChart(chart){
  if(chart?.version===1&&chart.table)return renderEvidenceChart(chart);
  if(chart?.version===1&&chart.kind==='line')return renderLineChart(chart);
  if(!chart||chart.version!==1||chart.kind!=='horizontal_bar'||!Array.isArray(chart.groups)||!chart.groups.length)return null;
  const figure=document.createElement('figure');figure.className='inline-chart';figure.tabIndex=0;figure.setAttribute('aria-labelledby',`${chart.id}-title`);
  const caption=document.createElement('figcaption'),title=document.createElement('strong'),meta=document.createElement('span');title.id=`${chart.id}-title`;title.textContent=chart.title;meta.textContent=`${chart.period} · ${chart.metric} · ${chart.source}`;caption.append(title,meta);figure.append(caption);
  for(const [groupIndex,group] of chart.groups.entries()){const section=document.createElement('section'),heading=document.createElement('h4');heading.textContent=group.label;section.append(heading);const max=Math.max(...group.items.map(x=>x.value),1),list=document.createElement('ol');list.className='inline-bars';list.id=`${chart.id}-group-${groupIndex}`;for(const [itemIndex,item] of group.items.entries()){const value=group.currency?money(item.value,group.currency):`${count(item.value)} customers`,row=document.createElement('li');row.setAttribute('aria-label',`${item.rank}. ${item.label}: ${value}`);if(itemIndex>=5)row.hidden=true;const label=document.createElement('span'),track=document.createElement('span'),bar=document.createElement('span'),shown=document.createElement('span');label.className='bar-label';label.textContent=item.label;track.className='bar-track';track.setAttribute('aria-hidden','true');bar.className='bar-fill';bar.style.width=`${Math.max(1,item.value/max*100)}%`;track.append(bar);shown.className='bar-value';shown.textContent=value;row.append(label,track,shown);list.append(row)}section.append(list);if(group.items.length>5){const toggle=document.createElement('button');toggle.type='button';toggle.className='chart-toggle secondary';toggle.textContent='Show top 10';toggle.setAttribute('aria-expanded','false');toggle.setAttribute('aria-controls',list.id);toggle.onclick=()=>{const expanded=toggle.getAttribute('aria-expanded')==='true';for(const row of [...list.children].slice(5))row.hidden=expanded;toggle.setAttribute('aria-expanded',String(!expanded));toggle.textContent=expanded?'Show top 10':'Show top 5'};section.append(toggle)}figure.append(section)}
  if(chart.coverage?.length){const note=document.createElement('p');note.className='chart-coverage';note.textContent=`Unknown shipping country retained in coverage: ${chart.coverage.map(x=>`${x.currency} ${count(x.unknown_country_orders)} orders · ${money(x.unknown_country_sales,x.currency)}`).join('; ')}. Excluded from named-country rankings.`;figure.append(note)}return figure;
}

function renderLineChart(chart){
  if(!Array.isArray(chart.series)||!chart.series.length)return null;
  const valid=chart.series.filter(row=>/^20\d{2}-(?:0[1-9]|1[0-2])$/.test(row.period)&&typeof row.label==='string'&&(/^[A-Z]{3}$/.test(row.currency)||row.currency==='PCT')&&row.value!=null&&row.value!==''&&Number.isFinite(Number(row.value)));if(!valid.length)return null;
  const figure=document.createElement('figure');figure.className='inline-chart inline-line-chart';figure.tabIndex=0;figure.setAttribute('aria-labelledby',`${chart.id}-title`);const caption=document.createElement('figcaption'),title=document.createElement('strong'),meta=document.createElement('span');title.id=`${chart.id}-title`;title.textContent=chart.title;meta.textContent=`${chart.period} · ${chart.metric} · ${chart.source}`;caption.append(title,meta);figure.append(caption);
  const reportedPeriods=[...new Set(chart.series.map(row=>row.period).filter(value=>/^20\d{2}-(?:0[1-9]|1[0-2])$/.test(value)))].sort(),periods=[];for(let date=new Date(reportedPeriods[0]+'-01T00:00:00Z');date.toISOString().slice(0,7)<=reportedPeriods.at(-1)&&periods.length<120;date.setUTCMonth(date.getUTCMonth()+1))periods.push(date.toISOString().slice(0,7));const keys=[...new Set(valid.map(row=>`${row.label}|${row.currency}`))],max=Math.max(...valid.map(row=>Number(row.value)),1),svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 900 280');svg.setAttribute('role','img');svg.setAttribute('aria-label',`${chart.title}. Missing evidence is shown as a gap.`);const colors=['#c9a868','#75bb91','#7ca7cf','#d88972','#b78bd2'];
  keys.forEach((key,index)=>{const values=new Map(valid.filter(row=>`${row.label}|${row.currency}`===key).map(row=>[row.period,row.value])),segments=[];let points=[];for(const [i,p] of periods.entries()){if(!values.has(p)){if(points.length)segments.push(points);points=[];continue;}points.push(`${45+i*(810/Math.max(periods.length-1,1))},${235-Number(values.get(p))/max*190}`);}if(points.length)segments.push(points);for(const segment of segments){const line=document.createElementNS('http://www.w3.org/2000/svg','polyline');line.setAttribute('points',segment.join(' '));line.setAttribute('fill','none');line.setAttribute('stroke',colors[index%colors.length]);line.setAttribute('stroke-width','3');svg.append(line);}});figure.append(svg);
  const tableWrap=document.createElement('div');tableWrap.className='table-wrap chart-table';const table=document.createElement('table'),head=document.createElement('thead'),body=document.createElement('tbody');head.innerHTML=`<tr><th>Month</th><th>Series</th><th>${chart.percent?'Unit':'Currency'}</th><th>${chart.percent?'Rate':'Sales'}</th></tr>`;for(const row of valid){const tr=document.createElement('tr');for(const value of [row.period,row.label,row.currency==='PCT'?'Percent':row.currency,row.currency==='PCT'?`${Number(row.value).toFixed(2)}%`:money(row.value,row.currency)]){const td=document.createElement('td');td.textContent=value;tr.append(td)}body.append(tr)}table.append(head,body);tableWrap.append(table);figure.append(tableWrap);return figure;
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


function renderEvidenceChart(chart){
  if(!['line','horizontal_bar','grouped_bar','stacked_percentage_bar','stage_bar'].includes(chart.kind))return null;
  const figure=document.createElement('figure');figure.className='inline-chart';figure.tabIndex=0;
  figure.setAttribute('aria-label',chart.accessible_label);
  const caption=document.createElement('figcaption'),title=document.createElement('strong'),meta=document.createElement('span');title.textContent=chart.title;
  meta.textContent=`${chart.period} · ${chart.unit}`;caption.append(title,meta);figure.append(caption);
  if(chart.kind==='line'){
    const points=chart.series||[],periods=[...new Set([...(chart.period_axis||[]),...points.map(p=>p.period)])].sort(),values=points.map(p=>Number(p.value)),min=Math.min(0,...values),max=Math.max(1,...values),span=max-min||1;
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 900 280');svg.setAttribute('role','img');svg.setAttribute('aria-label',chart.accessible_label);
    const colors=['#c9a868','#75bb91','#7ca7cf','#d88972'];
    [...new Set(points.map(p=>p.label))].forEach((label,index)=>{
      const byPeriod=new Map(points.filter(p=>p.label===label).map(p=>[p.period,p]));let segment=[];
      const draw=()=>{if(!segment.length)return;const line=document.createElementNS('http://www.w3.org/2000/svg','polyline');line.setAttribute('points',segment.join(' '));line.setAttribute('fill','none');line.setAttribute('stroke',colors[index%colors.length]);line.setAttribute('stroke-width','3');svg.append(line);segment=[];};
      // Insert omitted calendar months as gaps; never interpolate missing facts.
      const axis=[];if(periods.every(p=>/^\d{4}-\d{2}$/.test(p))){for(let d=new Date(`${periods[0]}-01T00:00:00Z`);d.toISOString().slice(0,7)<=periods.at(-1)&&axis.length<120;d.setUTCMonth(d.getUTCMonth()+1))axis.push(d.toISOString().slice(0,7));}else axis.push(...periods);
      if(index===0){for(const [i,p] of axis.entries()){if(i!==0&&i!==axis.length-1&&i%Math.max(1,Math.ceil(axis.length/3)))continue;const tick=document.createElementNS('http://www.w3.org/2000/svg','text');tick.setAttribute('x',String(45+i*810/Math.max(axis.length-1,1)));tick.setAttribute('y','260');tick.setAttribute('text-anchor','middle');tick.setAttribute('fill','currentColor');tick.setAttribute('font-size','28');tick.textContent=p;svg.append(tick);}}
      const legend=document.createElement('span');legend.textContent=label;legend.style.color=colors[index%colors.length];legend.style.marginRight='1rem';figure.append(legend);
      axis.forEach((p,i)=>{const point=byPeriod.get(p);if(!point||point.value==null||!Number.isFinite(Number(point.value))){draw();return;}const x=45+i*810/Math.max(axis.length-1,1),y=235-(point.value-min)/span*190;segment.push(`${x},${y}`);const dot=document.createElementNS('http://www.w3.org/2000/svg','circle');dot.setAttribute('cx',String(x));dot.setAttribute('cy',String(y));dot.setAttribute('r','3');dot.setAttribute('fill',colors[index%colors.length]);const tooltip=document.createElementNS('http://www.w3.org/2000/svg','title');tooltip.textContent=`${label}, ${p}: ${count(point.value)} ${chart.unit}`;dot.append(tooltip);svg.append(dot);});draw();
    });figure.append(svg);
  }else if(chart.kind==='stacked_percentage_bar'){
    const colors=['#c9a868','#75bb91','#7ca7cf','#d88972','#b78bd2'];
    for(const group of chart.groups||[]){const heading=document.createElement('h4');heading.textContent=group.label;figure.append(heading);const stack=document.createElement('div');stack.style.display='flex';stack.style.width='100%';stack.style.minHeight='2rem';stack.setAttribute('role','img');stack.setAttribute('aria-label',group.items.map(item=>`${item.label}: ${count(item.value)}%`).join('; '));group.items.forEach((item,index)=>{const segment=document.createElement('span');segment.style.width=`${item.value}%`;segment.style.backgroundColor=colors[index%colors.length];segment.title=`${item.label}: ${count(item.value)}%`;segment.setAttribute('aria-hidden','true');stack.append(segment);});figure.append(stack);}
  }else{
    const all=(chart.groups||[]).flatMap(g=>g.items),commonMax=Math.max(1,...all.map(p=>Math.abs(p.value)));
    for(const group of chart.groups||[]){const max=group.currency?Math.max(1,...group.items.map(p=>Math.abs(p.value))):commonMax;const heading=document.createElement('h4');heading.textContent=group.label;figure.append(heading);const list=document.createElement('ol');list.className='inline-bars';
      for(const item of group.items){const row=document.createElement('li'),label=document.createElement('span'),track=document.createElement('span'),bar=document.createElement('span'),shown=document.createElement('span');label.className='bar-label';label.textContent=item.label;track.className='bar-track';track.setAttribute('aria-hidden','true');bar.className='bar-fill';bar.style.width=`${Math.abs(item.value)/max*100}%`;track.append(bar);shown.className='bar-value';shown.textContent=`${count(item.value)} ${group.currency||chart.unit}`;row.setAttribute('aria-label',`${item.label}: ${shown.textContent}`);row.append(label,track,shown);list.append(row);}figure.append(list);
    }
  }
  const wrap=document.createElement('div');wrap.className='table-wrap chart-table';const table=document.createElement('table'),head=document.createElement('thead'),body=document.createElement('tbody'),header=document.createElement('tr');
  const visible=chart.table.columns.map((_,i)=>i).filter(i=>!(i===1&&chart.table.columns[i]==='Series'&&chart.table.rows.every(r=>!r[i]||r[i]===r[2]))&&!(i===3&&chart.table.columns[i]==='Unit'&&chart.table.rows.every(r=>r[i]===chart.unit))&&!(i===0&&chart.table.columns[i]==='Period'&&chart.table.rows.every(r=>r[i]===chart.period)));
  for(const i of visible){const label=chart.table.columns[i]==='Value'?`${chart.metric||'Value'} (${chart.unit})`:chart.table.columns[i];const th=document.createElement('th');th.scope='col';th.textContent=label;header.append(th);}head.append(header);
  for(const values of chart.table.rows){const row=document.createElement('tr');for(const i of visible){const value=values[i];const td=document.createElement('td');td.textContent=value==null?'Unavailable':typeof value==='number'?count(value):String(value);row.append(td);}body.append(row);}table.append(head,body);wrap.append(table);figure.append(wrap);
  const note=document.createElement('p');note.textContent=`${chart.source}. ${chart.definition} `+`${chart.bounded?'Bounded results; no whole-population share is implied. ':''}Missing evidence is unavailable, never zero.`;figure.append(note);return figure;
}
