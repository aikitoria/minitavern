import type { WebSocket } from 'ws';
import type { TreeSnapshot } from '@minitavern/shared';
import { getActiveLeafId, getTreeMessages } from './tree.ts';
import { mergeLiveBuffers } from './generation.ts';
import { broadcastConv, sendTo } from './events.ts';

export function treeSnapshot(conversationId: number): TreeSnapshot {
  return {
    conversationId,
    messages: mergeLiveBuffers(getTreeMessages(conversationId)),
    activeLeafId: getActiveLeafId(conversationId),
  };
}

const pendingTreeBroadcasts = new Set<number>();

/**
 * Push the current tree to all subscribers of a conversation (after any
 * structural change). Coalesced per microtask: a request that mutates the
 * tree several times produces a single snapshot. Safe to defer because the
 * snapshot is taken at send time and merges in-flight stream buffers, and
 * clients treat a tree frame as a full replace.
 */
export function broadcastTree(conversationId: number): void {
  if (pendingTreeBroadcasts.has(conversationId)) return;
  pendingTreeBroadcasts.add(conversationId);
  queueMicrotask(() => {
    pendingTreeBroadcasts.delete(conversationId);
    broadcastConv(conversationId, { t: 'tree', ...treeSnapshot(conversationId) });
  });
}

/** Initial tree push when a client subscribes; live buffers included, deltas follow in order. */
export function sendTreeTo(ws: WebSocket, conversationId: number): void {
  sendTo(ws, { t: 'tree', ...treeSnapshot(conversationId) });
}
