import { db } from '../db.ts';
import { route, HttpError } from '../router.ts';
import { activateMessage, appendMessage, deleteMessage, getMessage } from '../tree.ts';
import { hasActiveGeneration, startGeneration, stopGeneration } from '../generation.ts';
import { broadcastTree } from '../sync.ts';
import { invalidate } from '../events.ts';
import { getConversation, spawnAssistantReply, touchConversation } from './conversations.ts';

function requireMessage(id: number) {
  const msg = getMessage(id);
  if (!msg) throw new HttpError(404, `message ${id} not found`);
  return msg;
}

function requireIdle(conversationId: number): void {
  if (hasActiveGeneration(conversationId)) {
    throw new HttpError(409, 'a generation is already running in this conversation');
  }
}

/** Regenerate: new assistant sibling under the same parent; the old reply stays navigable. */
route.post('/api/messages/:id/regenerate', ({ params }) => {
  const msg = requireMessage(Number(params.id));
  if (msg.role !== 'assistant')
    throw new HttpError(400, 'only assistant messages can be regenerated');
  requireIdle(msg.conversationId);
  const conv = getConversation(msg.conversationId);
  // A regeneration replaces this reply, so it keeps the speaker name it had.
  const mid = spawnAssistantReply(conv, msg.parentId, msg.name);
  invalidate('conversations');
  return { assistantMessageId: mid };
});

/** Resume: continue the last assistant reply in place via prefill-style trailing assistant message. */
route.post('/api/messages/:id/continue', ({ params }) => {
  const msg = requireMessage(Number(params.id));
  if (msg.role !== 'assistant') throw new HttpError(400, 'only assistant messages can be resumed');
  if (msg.status === 'streaming') throw new HttpError(409, 'message is still streaming');
  requireIdle(msg.conversationId);
  const conv = getConversation(msg.conversationId);
  if (conv.activeLeafId !== msg.id)
    throw new HttpError(400, 'only the last message on the branch can be resumed');
  db.prepare("UPDATE messages SET status = 'streaming' WHERE id = ?").run(msg.id);
  broadcastTree(msg.conversationId);
  startGeneration(conv, msg.id, { content: msg.content, reasoning: msg.reasoning ?? '' });
  invalidate('conversations');
  return { assistantMessageId: msg.id };
});

/** In-place edit (typo fixes, tweaking an AI reply) — no branch created. */
route.patch('/api/messages/:id', ({ params, body }) => {
  const msg = requireMessage(Number(params.id));
  const b = (body ?? {}) as { content?: string };
  if (typeof b.content !== 'string') throw new HttpError(400, 'content is required');
  if (msg.status === 'streaming') throw new HttpError(409, 'message is still streaming');
  db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(b.content, msg.id);
  touchConversation(msg.conversationId);
  broadcastTree(msg.conversationId);
  return getMessage(msg.id);
});

/** Edit-as-branch: new sibling with the edited content; for user messages a reply is generated. */
route.post('/api/messages/:id/edit-branch', ({ params, body }) => {
  const msg = requireMessage(Number(params.id));
  const b = (body ?? {}) as { content?: string };
  const content = (b.content ?? '').trim();
  if (!content) throw new HttpError(400, 'content is required');
  requireIdle(msg.conversationId);
  const sibling = appendMessage(
    msg.conversationId,
    msg.role,
    content,
    msg.parentId,
    'done',
    null,
    msg.role === 'assistant' ? msg.name : null,
  );
  let assistantMessageId: number | null = null;
  if (msg.role === 'user') {
    assistantMessageId = spawnAssistantReply(getConversation(msg.conversationId), sibling.id);
  } else {
    broadcastTree(msg.conversationId);
  }
  invalidate('conversations');
  return { messageId: sibling.id, assistantMessageId };
});

/** Branch switch: activate this sibling and restore its remembered descendant chain. */
route.post('/api/messages/:id/activate', ({ params }) => {
  const msg = requireMessage(Number(params.id));
  const leaf = activateMessage(msg.id);
  broadcastTree(msg.conversationId);
  return { activeLeafId: leaf };
});

route.del('/api/messages/:id', ({ params }) => {
  const msg = requireMessage(Number(params.id));
  stopGeneration(msg.id);
  deleteMessage(msg.id);
  touchConversation(msg.conversationId);
  broadcastTree(msg.conversationId);
  invalidate('conversations');
});

route.post('/api/generations/:id/stop', ({ params }) => {
  const mid = Number(params.id);
  const stopped = stopGeneration(mid);
  if (!stopped) throw new HttpError(404, 'no active generation for this message');
  return { stopped: true };
});
