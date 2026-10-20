// Same conservative normalization used by the merged analytical audit.
export function emailState(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!normalized) return {state:'missing', normalized:null};
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return {state:'malformed', normalized:null};
  if (/^(?:test|unknown|none|null|noemail|no-email|noreply|no-reply|guest|placeholder)(?:[+._-]|@)|@(?:example\.(?:com|org|net)|invalid\.|test\.)|\.(?:invalid|test)$/.test(normalized)) return {state:'placeholder', normalized:null};
  return {state:'usable', normalized};
}
