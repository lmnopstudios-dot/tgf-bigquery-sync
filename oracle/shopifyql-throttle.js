export const SHOPIFY_RATE_LIMIT_MESSAGE = 'Shopify inventory analysis is temporarily rate limited. Please try again shortly.';

export class ShopifyThrottleError extends Error {
  constructor(message = SHOPIFY_RATE_LIMIT_MESSAGE, metadata = {}) {
    super(message);
    this.name = 'ShopifyThrottleError';
    this.code = 'THROTTLED';
    this.retryable = false;
    this.publicMessage = SHOPIFY_RATE_LIMIT_MESSAGE;
    this.metadata = metadata;
  }
}

const throttleDetail = error => error?.errors?.find(item => item?.extensions?.code === 'THROTTLED');

// ShopifyQL queries are retried at most once, and only after the reported reset.
// The reserve leaves time for the model and HTTP layers to produce a terminal reply.
export async function runWithShopifyThrottle(operation, {
  deadlineAt,
  now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  maxWaitMs = 45_000,
  responseReserveMs = 10_000,
  bufferMs = 350,
  log = () => {}
} = {}) {
  const startedAt = now();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const value = await operation();
      log({ operation: 'shopifyql', elapsed_ms: now() - startedAt, retry_count: attempt, outcome: 'success' });
      return value;
    } catch (error) {
      const detail = throttleDetail(error);
      if (!detail) throw error;
      const cost = detail.extensions?.cost || {};
      const resetAt = cost.windowResetAt;
      const resetTime = Date.parse(resetAt);
      const waitMs = Number.isFinite(resetTime) ? Math.max(0, resetTime - now()) + bufferMs : null;
      const remainingMs = Number.isFinite(deadlineAt) ? deadlineAt - now() : 0;
      const canRetry = attempt === 0 && waitMs !== null && waitMs <= maxWaitMs && waitMs + responseReserveMs <= remainingMs;
      const metadata = {
        requested_query_cost: Number.isFinite(cost.requestedQueryCost) ? cost.requestedQueryCost : null,
        currently_available: Number.isFinite(cost.currentlyAvailable) ? cost.currentlyAvailable : null,
        reset_at: typeof resetAt === 'string' ? resetAt : null,
        wait_ms: waitMs,
        remaining_ms: Math.max(0, remainingMs),
        retry_count: attempt,
        retry_scheduled: canRetry
      };
      log({ operation: 'shopifyql', elapsed_ms: now() - startedAt, outcome: 'throttled', ...metadata });
      if (!canRetry) throw new ShopifyThrottleError(undefined, metadata);
      await sleep(waitMs);
    }
  }
  throw new ShopifyThrottleError();
}
