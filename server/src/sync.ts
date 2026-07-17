import type { WebSocket } from 'ws';
import type { Message, TreeSnapshot } from '@minitavern/shared';
import {
  getActiveLeafId,
  getMessage,
  getTreeMessages,
  getTreeNodes,
  takeDirtyMessageIds,
} from './tree.ts';
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
 * Push the current tree structure to all subscribers of a conversation
 * (after any structural change). Coalesced per microtask: a request that
 * mutates the tree several times produces a single frame. The frame is an
 * incremental patch — structure for every message, full bodies only for
 * messages created/edited since the last frame (subscribers got a full
 * snapshot on subscribe, and frames arrive in order).
 */
export function broadcastTree(conversationId: number): void {
  if (pendingTreeBroadcasts.has(conversationId)) return;
  pendingTreeBroadcasts.add(conversationId);
  queueMicrotask(() => {
    pendingTreeBroadcasts.delete(conversationId);
    const bodies: Message[] = [];
    for (const id of takeDirtyMessageIds(conversationId)) {
      const msg = getMessage(id); // dirty id may have been deleted in the same batch
      if (msg) bodies.push(msg);
    }
    broadcastConv(conversationId, {
      t: 'treePatch',
      conversationId,
      activeLeafId: getActiveLeafId(conversationId),
      nodes: getTreeNodes(conversationId),
      messages: mergeLiveBuffers(bodies),
    });
  });
}

/** Initial tree push when a client subscribes; live buffers included, deltas follow in order. */
export function sendTreeTo(ws: WebSocket, conversationId: number): void {
  sendTo(ws, { t: 'tree', ...treeSnapshot(conversationId) });
}
