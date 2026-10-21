import {createHash} from 'node:crypto';
import {HISTORY_SCOPE} from './history-sql.js';

// This serialization is persisted identity. Keep order, null and fixed dates
// compatible with collectors shipped before this helper existed.
export function historySelectionKey({source,adapter,start=HISTORY_SCOPE.start,end=HISTORY_SCOPE.end,evidenceTable=null,revision='history-20261020-v2'}) {
  return createHash('sha256').update(JSON.stringify([source,adapter,start,end,evidenceTable,revision])).digest('hex');
}
