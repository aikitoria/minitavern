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

/** Push the current tree to all subscribers of a conversation (after any structural change). */
export function broadcastTree(conversationId: number): void {
  broadcastConv(conversationId, { t: 'tree', ...treeSnapshot(conversationId) });
}

/** Initial tree push when a client subscribes; live buffers included, deltas follow in order. */
export function sendTreeTo(ws: WebSocket, conversationId: number): void {
  sendTo(ws, { t: 'tree', ...treeSnapshot(conversationId) });
}
