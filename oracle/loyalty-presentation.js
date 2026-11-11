// Pure rendering from validated retained evidence. Never calls a provider.
export function loyaltyMarkdown(e){
 const text=v=>String(v??'Unavailable').replaceAll('|','\\|').replaceAll('\n',' ').replaceAll('<','&lt;').replaceAll('>','&gt;');
 const lines=['# LoyaltyLion reporting',`Current snapshot metrics are observed at ${text(e.as_of)}. Dates filter points and claims; they do not turn current membership into historical membership.`];
 for(const s of e.sections||[]){
  lines.push('',`## ${text(s.section)}`);
  if(s.status==='unavailable'){lines.push(`Unavailable: ${text(s.code)}.`);continue;}
  lines.push(`Evidence status: ${text(s.status)}.`);if(s.definition)lines.push(text(s.definition));
  if(!s.rows.length){lines.push(s.coverage_complete?'No observations in certified collected coverage.':'No observations returned; complete coverage is not established.');continue;}
  const keys=[...new Set(s.rows.flatMap(Object.keys))];lines.push('| '+keys.map(text).join(' | ')+' |','| '+keys.map(()=>'---').join(' | ')+' |',...s.rows.map(r=>'| '+keys.map(k=>text(r[k])).join(' | ')+' |'));
  if(s.linkage_coverage)lines.push('Linkage coverage (all requested point records before channel/currency filtering): '+Object.entries(s.linkage_coverage).map(([k,v])=>`${text(k)}: ${text(v)}`).join('; ')+'.');
 }
 if(e.comparison)lines.push('',`Comparison ${text(e.comparison.start_date)} to ${text(e.comparison.end_date)}: unavailable (${text(e.comparison.code)}). Primary evidence is retained.`);
 lines.push('',...(e.limitations||[]).map(s=>'- '+text(s)));return lines;
}
