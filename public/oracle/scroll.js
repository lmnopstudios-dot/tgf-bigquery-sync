export const DEFAULT_FOLLOW_DISTANCE = 120;

export function isNearConversationEnd(container, threshold = DEFAULT_FOLLOW_DISTANCE) {
  return container.scrollHeight - container.scrollTop - container.clientHeight <= threshold;
}

export function scrollConversationToEnd(container) {
  container.scrollTop = container.scrollHeight;
}

export function appendToConversation(container, node, threshold = DEFAULT_FOLLOW_DISTANCE) {
  const shouldFollow = isNearConversationEnd(container, threshold);
  container.append(node);
  if (shouldFollow) scrollConversationToEnd(container);
  return shouldFollow;
}

export function updateConversationContent(container, update, threshold = DEFAULT_FOLLOW_DISTANCE) {
  const shouldFollow = isNearConversationEnd(container, threshold);
  update();
  if (shouldFollow) scrollConversationToEnd(container);
  return shouldFollow;
}
