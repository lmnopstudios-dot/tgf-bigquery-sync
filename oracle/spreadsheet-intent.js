// Formatting-only requests never authorize provider refresh or change population.
export function isSpreadsheetFollowup(message){
 const t=String(message||'').trim().replace(/[.!?]+$/,'').trim();
 if(/^(?:please\s+)?(?:export|download)\s+(?:this|that|it|these results|those results|the results)(?:\s+please)?$/i.test(t))return true;
 return /^(?:please\s+)?(?:(?:can|could|may)\s+(?:i|we)\s+(?:please\s+)?(?:get|have)|(?:can|could|would)\s+you\s+(?:please\s+)?(?:give|send|export|download|make|put|save)|(?:give|send)(?:\s+me)?|(?:put|make|export|download|save)|i(?:'d| would) like)\s+(?:me\s+)?(?:this|that|it|these results|those results|the results|your (?:answer|response)|the (?:report|table))(?:\s+(?:as|in|into|to))?(?:\s+(?:an?|an? downloadable|downloadable))?\s*(?:excel(?:\s+(?:file|workbook|spreadsheet))?|xlsx|spread\s*sheet|workbook)(?:\s+(?:please|for me))?$/i.test(t)
  || /^(?:an?\s+)?(?:excel|xlsx|spread\s*sheet|workbook)(?:\s+(?:please|version|download))?$/i.test(t);
}
