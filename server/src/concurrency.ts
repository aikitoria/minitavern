import { stmt } from './db.ts';
import { HttpError } from './router.ts';
import { broadcastTree } from './sync.ts';

export function requireExpectedActiveLeaf(
  conversationId: number,
  expectedActiveLeafId: number | null | undefined,
): void {
  if (expectedActiveLeafId === undefined) {
    throw new HttpError(400, 'expectedActiveLeafId is required');
  }
  const row = stmt('SELECT active_leaf_id FROM conversations WHERE id = ?').get(conversationId) as
    { active_leaf_id: number | null } | undefined;
  if (!row) throw new HttpError(404, `conversation ${conversationId} not found`);
  if (row.active_leaf_id !== expectedActiveLeafId) {
    broadcastTree(conversationId);
    throw new HttpError(409, 'conversation branch changed; please try again');
  }
}
