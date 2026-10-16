// Entity selection is independent of calendar reporting dates and presentation.
const counts = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};
export function relativeEntitySelection(
  text,
  { entityPattern, continuation = false, defaultCount = 1 } = {},
) {
  const countPattern = '(\\d+|' + Object.keys(counts).join('|') + ')';
  const match = text.match(
    new RegExp(
      '\\b(last|latest|most recently sent|most recent|previous)\\s+(?:' +
        countPattern +
        '\\s+)?(?:sent\\s+)?' +
        entityPattern +
        '\\b',
      'i',
    ),
  );
  const counted = text.match(
    new RegExp(
      '\\b' +
        countPattern +
        '\\s+(?:most recently sent|most recent|latest|last)\\s+(?:sent\\s+)?' +
        entityPattern +
        '\\b',
      'i',
    ),
  );
  const previous =
    continuation &&
    text.match(
      new RegExp('\\b(?:previous|before)\\s+(?:' + countPattern + '\\b)?', 'i'),
    );
  const m = match || counted || previous;
  if (!m) return null;
  const token = match?.[2] || counted?.[1] || previous?.[1],
    count = token ? counts[token.toLowerCase()] || Number(token) : defaultCount;
  if (!Number.isInteger(count) || count < 1 || count > 10)
    return { unsupported: true };
  return {
    rule: /previous|before/i.test(match?.[1] || previous?.[0])
      ? 'previous'
      : 'latest',
    count,
    ordering_basis: 'actual_send_time_desc',
  };
}
export const entityIdentity = (c) =>
  JSON.stringify([c.account, c.channel, c.entity_id]);
export function selectSentEntities(
  candidates,
  { count = 1, offset = 0, cutoff, channel, account },
) {
  const dedup = new Map();
  let missingSend = false;
  for (const c of candidates) {
    if (
      !c.entity_id ||
      c.entity_kind === 'flow' ||
      c.report_kind === 'flow' ||
      c.channel === 'flow' ||
      c.is_sent === false ||
      (c.status && !['sent', 'sending'].includes(c.status.toLowerCase())) ||
      (channel && c.channel !== channel) ||
      (account && c.account !== account)
    )
      continue;
    if (
      c.send_time_semantics !== 'actual campaign send timestamp' ||
      !Number.isFinite(Date.parse(c.send_time))
    ) {
      missingSend = true;
      continue;
    }
    if (Date.parse(c.send_time) > Date.parse(cutoff)) continue;
    const key = entityIdentity(c),
      prior = dedup.get(key);
    // The source campaign identity collapses message variants and metadata snapshots.
    if (prior && Date.parse(prior.send_time) !== Date.parse(c.send_time))
      return { blocker: 'conflicting_send_metadata' };
    if (
      !prior ||
      String(c.retrieved_at || '') > String(prior.retrieved_at || '')
    )
      dedup.set(key, c);
  }
  if (missingSend) return { blocker: 'missing_send_metadata' };
  const groups = new Map();
  for (const c of dedup.values()) {
    const key = JSON.stringify([c.account, c.channel]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  if (groups.size > 1)
    return { ambiguous: [...groups.values()].map((g) => g[0]) };
  const ordered = [...dedup.values()].sort(
    (a, b) =>
      Date.parse(b.send_time) - Date.parse(a.send_time) ||
      a.entity_id.localeCompare(b.entity_id),
  );
  const selected = ordered.slice(offset, offset + count);
  return { selected, available: ordered.length };
}
