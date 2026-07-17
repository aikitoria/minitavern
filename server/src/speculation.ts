import { db } from './db.ts';
import { stopAllBackgroundGenerations, stopBackgroundGeneration } from './generation.ts';
import { broadcastTree } from './sync.ts';

const retryTimers = new Map<number, NodeJS.Timeout>();
let refillHandler: ((conversationId?: number) => void) | null = null;

/** Installed at startup to lazily restore the one-ahead invariant for visible chats. */
export function setSpeculativeRefillHandler(handler: (conversationId?: number) => void): void {
  refillHandler = handler;
}

/** Cancels delayed refill attempts after the leaf or generation context changes. */
export function cancelSpeculativeRetries(conversationId?: number): void {
  if (conversationId != null) {
    const timer = retryTimers.get(conversationId);
    if (timer) clearTimeout(timer);
    retryTimers.delete(conversationId);
    return;
  }
  for (const timer of retryTimers.values()) clearTimeout(timer);
  retryTimers.clear();
}

/** Keeps retrying failed background requests without creating concurrent refills. */
export function scheduleSpeculativeRetry(
  conversationId: number,
  attempt: number,
  retry: () => void,
): void {
  cancelSpeculativeRetries(conversationId);
  const delay = Math.min(500 * 2 ** Math.min(Math.max(attempt - 1, 0), 6), 30_000);
  retryTimers.set(
    conversationId,
    setTimeout(() => {
      retryTimers.delete(conversationId);
      retry();
    }, delay),
  );
}

/** Removes unread speculative siblings and returns the conversations that changed. */
export function discardSpeculativeSwipes(conversationId?: number): number[] {
  cancelSpeculativeRetries(conversationId);
  if (conversationId == null) stopAllBackgroundGenerations();
  else stopBackgroundGeneration(conversationId);

  const rows = db
    .prepare(
      `SELECT DISTINCT conversation_id FROM messages
       WHERE generation_kind = 'speculative'
       ${conversationId == null ? '' : 'AND conversation_id = ?'}`,
    )
    .all(...(conversationId == null ? [] : [conversationId])) as { conversation_id: number }[];
  if (conversationId == null) {
    db.prepare("DELETE FROM messages WHERE generation_kind = 'speculative'").run();
  } else {
    db.prepare(
      "DELETE FROM messages WHERE generation_kind = 'speculative' AND conversation_id = ?",
    ).run(conversationId);
  }
  for (const row of rows) broadcastTree(row.conversation_id);
  queueMicrotask(() => refillHandler?.(conversationId));
  return rows.map((row) => row.conversation_id);
}

export function markSwipeRead(messageId: number): void {
  db.prepare("UPDATE messages SET generation_kind = 'normal' WHERE id = ?").run(messageId);
}
