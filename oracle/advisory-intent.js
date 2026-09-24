// Stock-clearance requests are identified from the combination of the business
// objective and an ask for action, rather than from one production sentence.
// This intentionally does not treat a generic request for sales data as advice.
const STOCK = /\b(?:stock|inventory|units?|items?|products?)\b/i;
const CLEARANCE_OBJECTIVE = /\b(?:clear(?:ing|ance)?|reduce|run down|sell through|shift|move|liquidat(?:e|ing|ion)|overstock(?:ed)?|excess|slow[- ]moving)\b/i;
const ADVICE_ASK = /\b(?:what (?:can|could|should) (?:we|i) do|how (?:can|could|should) (?:we|i)|ideas?|recommend(?:ation|ations|ed)?|suggest(?:ion|ions)?|options?|strategy|strategies|tactics?|plan|approach)\b/i;

export function hasStockClearanceObjective(message) {
  const text = String(message || '');
  return STOCK.test(text) && CLEARANCE_OBJECTIVE.test(text);
}

export function isStockClearanceAdvisory(message, existing = {}) {
  const text = String(message || '');
  const clearanceContext = hasStockClearanceObjective(text) || existing.request_kind === 'advisory' && existing.advisory_topic === 'stock_clearance';
  // A pasted clearance brief establishes session context even if the actual ask
  // arrives as the next message. Once established, ordinary action-oriented
  // follow-ups retain that meaning.
  return hasStockClearanceObjective(text) || clearanceContext && ADVICE_ASK.test(text);
}
