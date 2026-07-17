import { stmt } from '../db.ts';
import { route, HttpError } from '../router.ts';
import {
  activateMessage,
  appendMessage,
  deleteMessage,
  getMessage,
  markMessageDirty,
} from '../tree.ts';
import {
  hasActiveGeneration,
  hasForegroundGeneration,
  isBackgroundGeneration,
  promoteBackgroundGeneration,
  startGeneration,
  stopGeneration,
} from '../generation.ts';
import { broadcastTree } from '../sync.ts';
import { invalidate } from '../events.ts';
import {
  cancelBackgroundSwipe,
  getConversation,
  prepareNextSwipe,
  spawnAssistantReply,
  touchConversation,
} from './conversations.ts';
import { objectBody, positiveId } from '../validation.ts';
import { optionalNullableId } from '../validation.ts';
import { requireExpectedActiveLeaf } from '../concurrency.ts';
import { discardSpeculativeSwipes, markSwipeRead, nextUnreadSibling } from '../speculation.ts';

function requireMessage(id: number) {
  const msg = getMessage(id);
  if (!msg) throw new HttpError(404, `message ${id} not found`);
  return msg;
}

function requireIdle(conversationId: number): void {
  cancelBackgroundSwipe(conversationId);
  if (hasActiveGeneration(conversationId)) {
    throw new HttpError(409, 'a generation is already running in this conversation');
  }
}

function requireExpectedLeaf(message: ReturnType<typeof requireMessage>, body: unknown): void {
  const b = objectBody(body);
  requireExpectedActiveLeaf(message.conversationId, optionalNullableId(b, 'expectedActiveLeafId'));
}

/** Resume: continue the last assistant reply in place via prefill-style trailing assistant message. */
route.post('/api/messages/:id/continue', ({ params, body }) => {
  const msg = requireMessage(positiveId(params.id));
  if (msg.role !== 'assistant') throw new HttpError(400, 'only assistant messages can be resumed');
  if (msg.status === 'streaming') throw new HttpError(409, 'message is still streaming');
  const conv = getConversation(msg.conversationId);
  requireExpectedLeaf(msg, body);
  if (conv.activeLeafId !== msg.id)
    throw new HttpError(400, 'only the last message on the branch can be resumed');
  requireIdle(msg.conversationId);
  stmt("UPDATE messages SET status = 'streaming' WHERE id = ?").run(msg.id);
  broadcastTree(msg.conversationId);
  startGeneration(
    conv,
    msg.id,
    { content: msg.content, reasoning: msg.reasoning ?? '' },
    { onDone: () => prepareNextSwipe(msg.id) },
  );
  invalidate('conversations');
  return { assistantMessageId: msg.id };
});

/** Atomically move to the next assistant sibling, creating it when needed. */
route.post('/api/messages/:id/advance', ({ params, body }) => {
  const msg = requireMessage(positiveId(params.id));
  if (msg.role !== 'assistant') throw new HttpError(400, 'only assistant messages can advance');
  requireExpectedLeaf(msg, body);

  const nextId = nextUnreadSibling(msg);

  if (nextId != null) {
    if (hasActiveGeneration(msg.conversationId)) {
      if (isBackgroundGeneration(nextId)) promoteBackgroundGeneration(nextId);
      else if (!stopGeneration(msg.id)) {
        throw new HttpError(409, 'a different generation is already running');
      }
    }
    markSwipeRead(nextId);
    const leaf = activateMessage(nextId);
    broadcastTree(msg.conversationId);
    prepareNextSwipe(leaf);
    invalidate('conversations');
    return { activeLeafId: leaf, assistantMessageId: null };
  }

  if (hasActiveGeneration(msg.conversationId) && !stopGeneration(msg.id)) {
    throw new HttpError(409, 'a different generation is already running');
  }
  const mid = spawnAssistantReply(getConversation(msg.conversationId), msg.parentId, msg.name);
  invalidate('conversations');
  return { activeLeafId: mid, assistantMessageId: mid };
});

/** In-place edit (typo fixes, tweaking an AI reply) — no branch created. */
route.patch('/api/messages/:id', ({ params, body }) => {
  const msg = requireMessage(positiveId(params.id));
  const b = objectBody(body);
  if (typeof b.content !== 'string') throw new HttpError(400, 'content is required');
  const content = b.content.trim();
  if (!content) throw new HttpError(400, 'content is required');
  requireExpectedActiveLeaf(msg.conversationId, optionalNullableId(b, 'expectedActiveLeafId'));
  if (msg.status === 'streaming') throw new HttpError(409, 'message is still streaming');
  if (hasForegroundGeneration(msg.conversationId)) {
    throw new HttpError(409, 'a generation is already running in this conversation');
  }
  discardSpeculativeSwipes(msg.conversationId);
  stmt('UPDATE messages SET content = ? WHERE id = ?').run(content, msg.id);
  markMessageDirty(msg.conversationId, msg.id);
  touchConversation(msg.conversationId);
  broadcastTree(msg.conversationId);
  return getMessage(msg.id);
});

/** Edit-as-branch: new sibling with the edited content; for user messages a reply is generated. */
route.post('/api/messages/:id/edit-branch', ({ params, body }) => {
  const msg = requireMessage(positiveId(params.id));
  const b = objectBody(body);
  const content = (typeof b.content === 'string' ? b.content : '').trim();
  if (!content) throw new HttpError(400, 'content is required');
  requireExpectedActiveLeaf(msg.conversationId, optionalNullableId(b, 'expectedActiveLeafId'));
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
route.post('/api/messages/:id/activate', ({ params, body }) => {
  const msg = requireMessage(positiveId(params.id));
  requireExpectedLeaf(msg, body);
  if (hasActiveGeneration(msg.conversationId)) {
    if (isBackgroundGeneration(msg.id)) promoteBackgroundGeneration(msg.id);
    else requireIdle(msg.conversationId);
  }
  markSwipeRead(msg.id);
  const leaf = activateMessage(msg.id);
  broadcastTree(msg.conversationId);
  prepareNextSwipe(leaf);
  invalidate('conversations');
  return { activeLeafId: leaf };
});

route.del('/api/messages/:id', ({ params, req }) => {
  const msg = requireMessage(positiveId(params.id));
  const rawExpected = new URL(req.url ?? '/', 'http://x').searchParams.get('expectedActiveLeafId');
  const expected =
    rawExpected === 'null' ? null : rawExpected == null ? undefined : Number(rawExpected);
  requireExpectedActiveLeaf(msg.conversationId, expected);
  requireIdle(msg.conversationId);
  deleteMessage(msg.id);
  touchConversation(msg.conversationId);
  broadcastTree(msg.conversationId);
  invalidate('conversations');
});

route.post('/api/generations/:id/stop', ({ params }) => {
  const mid = positiveId(params.id);
  if (isBackgroundGeneration(mid)) {
    throw new HttpError(409, 'inactive background swipes cannot be stopped directly');
  }
  const stopped = stopGeneration(mid);
  if (!stopped) throw new HttpError(404, 'no active generation for this message');
  return { stopped: true };
});
