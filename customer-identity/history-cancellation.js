import {AsyncLocalStorage} from 'node:async_hooks';

// Scope cancellation to one CLI operation; imported collector callers are unchanged.
const ownership = new AsyncLocalStorage();
export const historySignal = () => ownership.getStore();
export const withHistorySignal = (signal, work) => ownership.run(signal, work);
export function checkHistorySignal() {
  if (historySignal()?.aborted) throw Object.assign(Error('History interrupted'), {code:'REQUEST_CANCELLED'});
}
