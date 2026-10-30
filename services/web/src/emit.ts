// Ereignisse, die der Web-Dienst selbst ausloest, laufen ueber dieselbe Outbox wie die der anderen
// Dienste. So gibt es genau einen Weg zu den SSE-Clients (und andere Browser-Tabs sehen Aenderungen).
import { pushEvent } from './db.js';
import { withTx, type Db } from './sqlite.js';

export function emitMessageUpdated(db: Db, messageIds: string[]): void {
  if (messageIds.length === 0) return;
  withTx(db, () => {
    for (const id of messageIds) pushEvent(db, 'message_updated', { messageId: id });
  });
}
