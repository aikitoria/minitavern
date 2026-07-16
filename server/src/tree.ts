import type { Message, MessageStatus, Role } from '@minitavern/shared';
import { db, toMessage, transaction } from './db.ts';

interface MsgRow {
  id: number;
  conversation_id: number;
  parent_id: number | null;
  active_child_id: number | null;
}

function getRow(id: number): MsgRow | undefined {
  return db
    .prepare('SELECT id, conversation_id, parent_id, active_child_id FROM messages WHERE id = ?')
    .get(id) as MsgRow | undefined;
}

export function getMessage(id: number): Message | undefined {
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? toMessage(row) : undefined;
}

export function getTreeMessages(conversationId: number): Message[] {
  const rows = db
    .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id')
    .all(conversationId) as Record<string, unknown>[];
  return rows.map(toMessage);
}

export function getActiveLeafId(conversationId: number): number | null {
  const row = db.prepare('SELECT active_leaf_id FROM conversations WHERE id = ?').get(conversationId) as
    | { active_leaf_id: number | null }
    | undefined;
  return row?.active_leaf_id ?? null;
}

/** Active path, root -> leaf, computed by walking parent pointers up from the leaf. */
export function getActivePath(conversationId: number): Message[] {
  const path: Message[] = [];
  let cur = getActiveLeafId(conversationId);
  while (cur != null) {
    const msg = getMessage(cur);
    if (!msg) break;
    path.push(msg);
    cur = msg.parentId;
  }
  return path.reverse();
}

/**
 * Sets the conversation's active leaf and repoints active_child_id along the
 * whole new path. That invariant is what lets a later branch switch restore
 * the deep chain that was active beneath any node.
 */
export function setActiveLeaf(conversationId: number, leafId: number | null): void {
  db.prepare('UPDATE conversations SET active_leaf_id = ?, updated_at = ? WHERE id = ?').run(
    leafId,
    Date.now(),
    conversationId,
  );
  const setChild = db.prepare('UPDATE messages SET active_child_id = ? WHERE id = ?');
  let cur = leafId;
  while (cur != null) {
    const row = getRow(cur);
    if (!row) break;
    if (row.parent_id != null) setChild.run(cur, row.parent_id);
    cur = row.parent_id;
  }
}

/** Follows active_child_id pointers down from a node to the deepest remembered descendant. */
export function descendToLeaf(fromId: number): number {
  let cur = fromId;
  for (;;) {
    const row = getRow(cur);
    if (!row || row.active_child_id == null) return cur;
    const child = getRow(row.active_child_id);
    if (!child || child.parent_id !== cur) return cur;
    cur = child.id;
  }
}

/** Branch switch: make `messageId` the active sibling, restoring its remembered subtree path. */
export function activateMessage(messageId: number): number {
  const row = getRow(messageId);
  if (!row) throw new Error(`message ${messageId} not found`);
  return transaction(() => {
    const leaf = descendToLeaf(messageId);
    setActiveLeaf(row.conversation_id, leaf);
    return leaf;
  });
}

export function appendMessage(
  conversationId: number,
  role: Role,
  content: string,
  parentId: number | null,
  status: MessageStatus = 'done',
  model: string | null = null,
  name: string | null = null,
): Message {
  return transaction(() => {
    const result = db
      .prepare(
        `INSERT INTO messages (conversation_id, parent_id, role, content, status, model, name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(conversationId, parentId, role, content, status, model, name, Date.now());
    const id = Number(result.lastInsertRowid);
    setActiveLeaf(conversationId, id);
    return getMessage(id)!;
  });
}

function newestChildId(conversationId: number, parentId: number | null): number | null {
  const row = db
    .prepare(
      'SELECT id FROM messages WHERE conversation_id = ? AND parent_id IS ? ORDER BY id DESC LIMIT 1',
    )
    .get(conversationId, parentId) as { id: number } | undefined;
  return row?.id ?? null;
}

/** Deletes a message and its whole subtree (FK cascade), repairing the active path if needed. */
export function deleteMessage(messageId: number): void {
  const row = getRow(messageId);
  if (!row) return;
  const { conversation_id: conversationId, parent_id: parentId } = row;
  const onActivePath = getActivePath(conversationId).some((m) => m.id === messageId);
  transaction(() => {
    db.prepare('DELETE FROM messages WHERE id = ?').run(messageId);
    if (!onActivePath) return;
    const sibling = newestChildId(conversationId, parentId);
    const newLeaf = sibling != null ? descendToLeaf(sibling) : parentId;
    setActiveLeaf(conversationId, newLeaf);
  });
}
