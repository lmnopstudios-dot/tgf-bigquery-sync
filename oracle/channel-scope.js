// Exclusions may name several populations: "Exclude non-UK and POS orders".
// Only affirmative channel mentions can widen an online request to in-store.
export function requestsInStoreChannel(text) {
  const affirmative=String(text||'')
    .replace(/\b(?:exclude|excluding|without)\b[^.;\n]*?(?=\b(?:but|however|then|show|include|including)\b|[.;\n]|$)/gi,'')
    .replace(/\b(?:not|no)\s+(?:POS|point of sale|in[ -]?store)\b/gi,'');
  return /\b(?:POS|point of sale|in[ -]?store)\b/i.test(affirmative);
}
