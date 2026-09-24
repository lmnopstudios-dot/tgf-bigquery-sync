const MONTHS = new Map([
  ['january', 0], ['february', 1], ['march', 2], ['april', 3],
  ['may', 4], ['june', 5], ['july', 6], ['august', 7],
  ['september', 8], ['october', 9], ['november', 10], ['december', 11]
]);

const AFTER_DATE = /\bafter\s+(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})\b/i;
const EXPLICIT_UPPER_BOUND = /\b(?:before|until|through|up to|ending|and ending)\b|\bto\s+\d{1,2}\b/i;

function nextDay(day, monthName, year) {
  const value = new Date(Date.UTC(Number(year), MONTHS.get(monthName.toLowerCase()), Number(day)));
  if (value.getUTCDate() !== Number(day)) return null;
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

/**
 * Enforce date semantics that cannot safely be left to model inference at the
 * Oracle/tool boundary. Other date wording is deliberately untouched so that
 * explicit ranges and retained conversation scopes continue to pass through.
 */
export function applyOrderDateScope(userMessage, toolName, args) {
  if (toolName !== 'search_orders' || typeof userMessage !== 'string') return args;
  const currentMessage = userMessage.split(/Current user message:\s*/i).at(-1);
  const match = currentMessage.match(AFTER_DATE);
  if (!match) return args;

  const textAfterDate = currentMessage.slice((match.index ?? 0) + match[0].length);
  if (EXPLICIT_UPPER_BOUND.test(textAfterDate)) return args;

  const startDate = nextDay(match[1], match[2], match[3]);
  return startDate ? { ...args, start_date: startDate, end_date: null } : args;
}
