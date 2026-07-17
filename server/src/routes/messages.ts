import { stmt } from '../db.ts';
import { route, HttpError } from '../router.ts';
import {
  activateMessage,
  appendMessage,
  getActiveLeafId,
  getActivePath,
  getMessage,
  markMessageDirty,
  rotateDown,
  spliceMessage,
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
import { parseImageConfig, startImageRender } from '../comfy.ts';

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
  // finalize() clears image_pending on non-done endings, which would disown a
  // render started via render-image — keep the two exclusive.
  if (msg.imagePending) {
    throw new HttpError(409, 'an image render is running for this message');
  }
  const conv = getConversation(msg.conversationId);
  requireExpectedLeaf(msg, body);
  if (conv.activeLeafId !== msg.id)
    throw new HttpError(400, 'only the last message on the branch can be resumed');
  requireIdle(msg.conversationId);
  stmt("UPDATE messages SET status = 'streaming' WHERE id = ?").run(msg.id);
  touchConversation(msg.conversationId);
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
    // Revealing a not-yet-seen speculative reply is "new content" for the
    // sidebar, exactly like generating it in the foreground would have been.
    const wasUnread = getMessage(nextId)?.generationKind === 'speculative';
    if (hasActiveGeneration(msg.conversationId)) {
      if (isBackgroundGeneration(nextId)) promoteBackgroundGeneration(nextId);
      // A speculative stream in another sibling group loses its context on
      // this branch switch anyway — cancel it rather than refusing the swipe.
      else if (!stopGeneration(msg.id) && !cancelBackgroundSwipe(msg.conversationId)) {
        throw new HttpError(409, 'a different generation is already running');
      }
    }
    markSwipeRead(nextId);
    if (wasUnread) touchConversation(msg.conversationId);
    const leaf = activateMessage(nextId);
    broadcastTree(msg.conversationId);
    prepareNextSwipe(leaf);
    invalidate('conversations');
    return { activeLeafId: leaf, assistantMessageId: null };
  }

  if (
    hasActiveGeneration(msg.conversationId) &&
    !stopGeneration(msg.id) &&
    !cancelBackgroundSwipe(msg.conversationId)
  ) {
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
  invalidate('conversations');
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
    touchConversation(msg.conversationId);
    broadcastTree(msg.conversationId);
  }
  invalidate('conversations');
  return { messageId: sibling.id, assistantMessageId };
});

/** Branch switch: activate this sibling and restore its remembered descendant chain. */
route.post('/api/messages/:id/activate', ({ params, body }) => {
  const msg = requireMessage(positiveId(params.id));
  requireExpectedLeaf(msg, body);
  const wasUnread = msg.generationKind === 'speculative';
  if (hasActiveGeneration(msg.conversationId)) {
    if (isBackgroundGeneration(msg.id)) promoteBackgroundGeneration(msg.id);
    else requireIdle(msg.conversationId);
  }
  markSwipeRead(msg.id);
  if (wasUnread) touchConversation(msg.conversationId);
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
  // Removing a block changes the context every prepared swipe was generated for.
  discardSpeculativeSwipes(msg.conversationId);
  // Splice, not subtree-delete: the tree below reattaches to the parent.
  // Whole-branch removal is what /del (delete-tail) is for.
  spliceMessage(msg.id);
  touchConversation(msg.conversationId);
  broadcastTree(msg.conversationId);
  invalidate('conversations');
});

/** Moves a message's block one step up or down the visible chain. Down rotates
 * it with its active child's block; up is the same rotation on the parent. */
route.post('/api/messages/:id/move', ({ params, body }) => {
  const msg = requireMessage(positiveId(params.id));
  const b = objectBody(body);
  const direction = b.direction;
  if (direction !== 'up' && direction !== 'down') {
    throw new HttpError(400, "direction must be 'up' or 'down'");
  }
  requireExpectedLeaf(msg, body);
  requireIdle(msg.conversationId);
  if (!getActivePath(msg.conversationId).some((m) => m.id === msg.id)) {
    throw new HttpError(400, 'message is not on the active branch');
  }
  const target = direction === 'down' ? msg.id : msg.parentId;
  if (target == null) throw new HttpError(400, 'message is already at the top');
  // Reordering changes the context every prepared swipe was generated for.
  discardSpeculativeSwipes(msg.conversationId);
  if (!rotateDown(target)) throw new HttpError(400, 'message is already at the bottom');
  broadcastTree(msg.conversationId);
  return { activeLeafId: getActiveLeafId(msg.conversationId) };
});

/** Duplicates a message as a new activated sibling swipe (content, name,
 * reasoning and image render config; generated images are not shared). */
route.post('/api/messages/:id/duplicate', ({ params, body }) => {
  let msg = requireMessage(positiveId(params.id));
  requireExpectedLeaf(msg, body);
  requireIdle(msg.conversationId);
  // requireIdle may have deleted the message itself (in-flight speculative
  // sibling); re-fetch, and only completed content is worth copying.
  msg = requireMessage(msg.id);
  if (msg.status !== 'done') {
    throw new HttpError(400, 'only completed messages can be duplicated');
  }
  discardSpeculativeSwipes(msg.conversationId);
  const copy = appendMessage(
    msg.conversationId,
    msg.role,
    msg.content,
    msg.parentId,
    'done',
    msg.model,
    msg.name,
    false,
  );
  const renderRow = stmt('SELECT image_render_json FROM messages WHERE id = ?').get(msg.id) as {
    image_render_json: string | null;
  };
  stmt('UPDATE messages SET reasoning = ?, image_render_json = ? WHERE id = ?').run(
    msg.reasoning,
    renderRow.image_render_json,
    copy.id,
  );
  activateMessage(copy.id);
  touchConversation(msg.conversationId);
  broadcastTree(msg.conversationId);
  invalidate('conversations');
  return { messageId: copy.id, activeLeafId: copy.id };
});

/** Renders another image alternative: the stored workflow with the message's
 * current content as the prompt and a fresh random seed. Messages without a
 * stored config (pre-swipes renders) may supply one, which is then stored. */
route.post('/api/messages/:id/render-image', ({ params, body }) => {
  const msg = requireMessage(positiveId(params.id));
  const b = body == null ? {} : objectBody(body);
  const row = stmt('SELECT image_render_json FROM messages WHERE id = ?').get(msg.id) as {
    image_render_json: string | null;
  };
  if (msg.imagePending) {
    throw new HttpError(409, 'an image render is already running for this message');
  }
  if (msg.status === 'streaming') throw new HttpError(409, 'message is still streaming');
  if (!msg.content.trim()) throw new HttpError(400, 'message has no description to render');
  let config: { workflow: string; comfyUrl: string };
  if (row.image_render_json) {
    config = JSON.parse(row.image_render_json) as { workflow: string; comfyUrl: string };
  } else {
    try {
      config = parseImageConfig(b);
    } catch {
      throw new HttpError(400, 'message has no image render configuration');
    }
    stmt('UPDATE messages SET image_render_json = ? WHERE id = ?').run(
      JSON.stringify(config),
      msg.id,
    );
  }
  stmt('UPDATE messages SET image_pending = 1 WHERE id = ?').run(msg.id);
  markMessageDirty(msg.conversationId, msg.id);
  broadcastTree(msg.conversationId);
  startImageRender({
    conversationId: msg.conversationId,
    mid: msg.id,
    comfyUrl: config.comfyUrl,
    workflow: config.workflow,
    description: msg.content,
  });
  return { rendering: true };
});

/** Selects which image alternative a message displays (persisted, synced). */
route.post('/api/messages/:id/active-image', ({ params, body }) => {
  const msg = requireMessage(positiveId(params.id));
  const b = objectBody(body);
  const index = b.index;
  if (
    typeof index !== 'number' ||
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index >= msg.images.length
  ) {
    throw new HttpError(400, 'index out of range');
  }
  stmt('UPDATE messages SET active_image = ? WHERE id = ?').run(index, msg.id);
  markMessageDirty(msg.conversationId, msg.id);
  broadcastTree(msg.conversationId);
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
