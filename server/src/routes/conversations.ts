// RACE-FREE-BY-SYNCHRONY: every route handler in this file is race-free only
// because it runs fully synchronously between check and act (no `await`
// mid-handler) — Node's single thread then serializes handlers against each
// other and against generation/streaming callbacks. A single future `await`
// mid-handler reopens the double-generation and active-leaf races the guards
// below protect against.
import { randomUUID } from 'node:crypto';
import type { Conversation, GenerationKind, MessageStatus, Role } from '@minitavern/shared';
import { stmt, toConversation, transaction } from '../db.ts';
import { route, HttpError } from '../router.ts';
import {
  appendMessage,
  deleteMessage,
  getActiveLeafId,
  getActivePath,
  getMessage,
  getPathToMessage,
  getTreeMessages,
  setActiveLeaf,
  takeDirtyMessageIds,
} from '../tree.ts';
import { requireReference } from './entityUtils.ts';
import {
  buildChatMessages,
  buildToolPrompt,
  getCharacter,
  getPersona,
  substituteMacros,
} from '../prompt.ts';
import type { BuiltPrompt } from '../prompt.ts';
import { clearSettingReference, getSettings } from '../settingsStore.ts';
import {
  chatCompletionOnce,
  hasActiveGeneration,
  hasForegroundGeneration,
  startGeneration,
  stopBackgroundGenerations,
  stopConversationGenerations,
} from '../generation.ts';
import { broadcastTree, treeSnapshot } from '../sync.ts';
import { invalidate, subscribedConversationIds } from '../events.ts';
import {
  cancelSpeculativeRetries,
  discardSpeculativeSwipes,
  nextUnreadSibling,
  scheduleSpeculativeRetry,
} from '../speculation.ts';
import { requireExpectedActiveLeaf } from '../concurrency.ts';
import {
  collectConversationImages,
  collectSiblingSubtreeImages,
  copyImage,
  deleteImageFiles,
} from '../images.ts';
import { parseImageConfig, startImageRender } from '../comfy.ts';
import {
  objectBody,
  optionalNullableId,
  optionalNullableString,
  optionalString,
  positiveId,
  requiredString,
} from '../validation.ts';

export function getConversation(id: number): Conversation {
  const row = stmt('SELECT * FROM conversations WHERE id = ?').get(id) as
    Record<string, unknown> | undefined;
  if (!row) throw new HttpError(404, `conversation ${id} not found`);
  return toConversation(row);
}

export function touchConversation(id: number): void {
  stmt('UPDATE conversations SET updated_at = ? WHERE id = ?').run(Date.now(), id);
}

/** Removes an in-flight speculative sibling before a foreground action takes over. */
export function cancelBackgroundSwipe(conversationId: number): boolean {
  const mid = stopBackgroundGenerations(conversationId);
  if (mid == null) return false;
  deleteMessage(mid);
  // Callers may still 400 before their own broadcast (duplicate/move guards);
  // the deleted sibling must never linger on screen. Coalesced per microtask,
  // so successful routes pay nothing extra.
  broadcastTree(conversationId);
  return true;
}

/**
 * Speculative swipe work is only worthwhile while at least one client is
 * subscribed to the conversation. Every asynchronous continuation of the
 * speculative chain (spawn after a foreground reply, refill after a
 * speculative reply, retry after a failure) is gated on this, so closing all
 * clients stops the chain instead of burning upstream quota on replies nobody
 * will read. Synchronous entry points (routes, the subscribe/refill handlers)
 * stay ungated: an explicit user action or a new subscription always restarts
 * speculation.
 */
export function isConversationWatched(conversationId: number): boolean {
  return subscribedConversationIds().includes(conversationId);
}

/** Ensures the active assistant reply has one unread sibling ready or in progress. */
export function prepareNextSwipe(messageId: number, retryAttempt = 0): void {
  const message = getMessage(messageId);
  if (!message || message.role !== 'assistant' || message.status !== 'done') return;
  const conversation = getConversation(message.conversationId);
  if (conversation.activeLeafId !== message.id) return;
  if (!getSettings().backgroundSwipeGeneration || hasActiveGeneration(conversation.id)) return;

  if (nextUnreadSibling(message) != null) return;

  cancelSpeculativeRetries(conversation.id);

  const speculative = appendMessage(
    conversation.id,
    'assistant',
    '',
    message.parentId,
    'streaming',
    null,
    message.name,
    false,
    'speculative',
  );
  broadcastTree(conversation.id);
  startGeneration(getConversation(conversation.id), speculative.id, undefined, {
    background: true,
    onDone: () => {
      if (isConversationWatched(conversation.id)) prepareNextSwipe(speculative.id);
    },
    onError: () => {
      const row = getMessage(speculative.id);
      if (row?.generationKind !== 'speculative') return;
      deleteMessage(speculative.id);
      broadcastTree(conversation.id);
      if (!isConversationWatched(conversation.id)) return;
      scheduleSpeculativeRetry(conversation.id, retryAttempt + 1, () => {
        // Re-check at fire time: the last client may have left during the backoff.
        if (isConversationWatched(conversation.id)) prepareNextSwipe(message.id, retryAttempt + 1);
      });
    },
  });
}

export function prepareActiveSwipe(conversationId: number): void {
  const leaf = getActiveLeafId(conversationId);
  if (leaf != null) prepareNextSwipe(leaf);
}

/**
 * Creates the empty streaming assistant message and kicks off generation.
 * `speakerName` overrides the conversation's current speaker (e.g. a
 * regeneration keeps the name its siblings were sent with). `promptOverride`
 * pins a pre-built prompt (steered regenerations) so retries stay consistent.
 */
export function spawnAssistantReply(
  conversation: Conversation,
  parentId: number | null,
  speakerName: string | null = conversation.speakerName,
  promptOverride?: BuiltPrompt,
): number {
  const msg = appendMessage(
    conversation.id,
    'assistant',
    '',
    parentId,
    'streaming',
    null,
    speakerName,
  );
  touchConversation(conversation.id);
  broadcastTree(conversation.id);
  startGeneration(getConversation(conversation.id), msg.id, undefined, {
    prompt: promptOverride,
    onDone: () => {
      if (isConversationWatched(conversation.id)) prepareNextSwipe(msg.id);
      maybeAutoTitle(conversation.id, msg.id);
    },
  });
  return msg.id;
}

/** The placeholder title a greeting-less conversation gets from its first message. */
function derivedTitle(content: string): string {
  return content.length > 60 ? `${content.slice(0, 57)}…` : content;
}

const TITLE_INSTRUCTION =
  'Summarize this conversation in 3-6 words for a sidebar title. Reply with only the title, no quotes.';

/** One-shot title completion; null on any failure (caller keeps the old title). */
async function requestTitle(
  conv: Conversation,
  userText: string,
  assistantText: string,
): Promise<string | null> {
  const clip = (s: string) => (s.length > 1000 ? `${s.slice(0, 1000)}…` : s);
  try {
    const raw = await chatCompletionOnce(
      conv,
      [
        {
          role: 'user',
          content: `${TITLE_INSTRUCTION}\n\nUser: ${clip(userText)}\n\nAssistant: ${clip(assistantText)}`,
        },
      ],
      30,
    );
    const title = raw
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '')
      .trim();
    if (!title) return null;
    return title.length > 60 ? `${title.slice(0, 57)}…` : title;
  } catch (err) {
    console.warn(
      `[conversations] auto-title failed for conversation ${conv.id}:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * LLM auto-titling: after the FIRST assistant reply in a "New chat"
 * conversation completes, replace the placeholder/fallback title with a
 * generated one. Runs even with no subscribed client (the reply itself was
 * foreground) and is silent on failure — the existing title stays.
 */
function maybeAutoTitle(conversationId: number, assistantMessageId: number): void {
  const conv = getConversation(conversationId);
  const history = getPathToMessage(getMessage(assistantMessageId)?.parentId ?? null);
  // The first exchange is exactly one user message below the root.
  const first = history.length === 1 && history[0]!.role === 'user' ? history[0]! : null;
  if (!first) return;
  // Anything but the placeholder or the first-message-derived fallback counts
  // as a title the user (or a previous auto-title run) chose — leave it alone.
  const fallback = derivedTitle(first.content);
  if (conv.title !== 'New chat' && conv.title !== fallback) return;
  const reply = getMessage(assistantMessageId)?.content ?? '';
  void requestTitle(conv, first.content, reply).then((title) => {
    if (!title) return;
    // The call is async: re-check that nobody renamed (or deleted) meanwhile.
    const latest = stmt('SELECT title FROM conversations WHERE id = ?').get(conversationId) as
      { title: string } | undefined;
    if (!latest || (latest.title !== 'New chat' && latest.title !== fallback)) return;
    // No updated_at bump: a title is metadata, not "new content" (same
    // doctrine as the PATCH rename route).
    stmt('UPDATE conversations SET title = ? WHERE id = ?').run(title, conversationId);
    invalidate('conversations');
  });
}

function getAlternateGreetings(characterId: number): string[] {
  const row = stmt('SELECT card_json FROM characters WHERE id = ?').get(characterId) as
    { card_json: string | null } | undefined;
  if (!row?.card_json) return [];
  try {
    const card = JSON.parse(row.card_json) as { data?: { alternate_greetings?: unknown } };
    const alts = card.data?.alternate_greetings;
    return Array.isArray(alts) ? alts.filter((a): a is string => typeof a === 'string') : [];
  } catch {
    return [];
  }
}

route.get('/api/conversations', () => {
  const rows = stmt('SELECT * FROM conversations ORDER BY updated_at DESC').all() as Record<
    string,
    unknown
  >[];
  return rows.map(toConversation);
});

route.post('/api/conversations', ({ body }) => {
  const b = objectBody(body);
  const characterId = optionalNullableId(b, 'characterId') ?? null;
  const settings = getSettings();
  const character = getCharacter(characterId);
  if (characterId != null && !character) throw new HttpError(400, 'characterId does not exist');
  // Settings are JSON rather than foreign-keyed rows, so tolerate and repair a stale default.
  const persona = getPersona(settings.defaultPersonaId);
  if (settings.defaultPersonaId != null && !persona) {
    clearSettingReference('defaultPersonaId', settings.defaultPersonaId);
    invalidate('settings');
  }
  const now = Date.now();
  const id = transaction(() => {
    const result = stmt(
      `INSERT INTO conversations (title, character_id, persona_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
    ).run(
      // Greeting-less chats (assistants) start as 'New chat' so the first
      // message auto-titles them; greeting characters keep their name.
      character?.firstMessage.trim() ? character.name : 'New chat',
      character?.id ?? null,
      persona?.id ?? null,
      now,
      now,
    );
    const convId = Number(result.lastInsertRowid);
    if (character?.firstMessage.trim()) {
      const sub = (text: string) => substituteMacros(text, character.name, persona?.name ?? 'User');
      appendMessage(convId, 'assistant', sub(character.firstMessage), null);
      // Imported cards may carry alternate greetings — seed them as root
      // siblings so they're swipeable, without stealing the primary's active slot.
      for (const alt of getAlternateGreetings(character.id)) {
        if (alt.trim())
          appendMessage(convId, 'assistant', sub(alt), null, 'done', null, null, false);
      }
    }
    return convId;
  });
  invalidate('conversations');
  return getConversation(id);
});

route.patch('/api/conversations/:id', ({ params, body }) => {
  const id = positiveId(params.id);
  const conv = getConversation(id);
  const b = objectBody(body);
  const title = optionalString(b, 'title');
  if (title !== undefined && !title.trim()) throw new HttpError(400, 'title is required');
  const characterId = optionalNullableId(b, 'characterId');
  const personaId = optionalNullableId(b, 'personaId');
  const endpointId = optionalNullableId(b, 'endpointId');
  const speakerName = optionalNullableString(b, 'speakerName');
  if (characterId != null && !getCharacter(characterId)) {
    throw new HttpError(400, 'characterId does not exist');
  }
  if (personaId != null && !getPersona(personaId)) {
    throw new HttpError(400, 'personaId does not exist');
  }
  requireReference('endpoints', endpointId, 'endpointId');
  const contextChanged =
    (characterId !== undefined && characterId !== conv.characterId) ||
    (personaId !== undefined && personaId !== conv.personaId) ||
    (endpointId !== undefined && endpointId !== conv.endpointId) ||
    (speakerName !== undefined && (speakerName?.trim() || null) !== conv.speakerName);
  // Only prompt-affecting changes conflict with an in-flight reply; a title
  // rename is always safe (the endpoint too is resolved once at gen start).
  if (contextChanged && hasForegroundGeneration(id))
    throw new HttpError(409, 'a generation is already running in this conversation');
  if (contextChanged) discardSpeculativeSwipes(id);
  // No updated_at bump: metadata edits are not "new content" and must not
  // reorder the sidebar (same doctrine as setActiveLeaf).
  stmt(
    `UPDATE conversations SET title = ?, character_id = ?, persona_id = ?, endpoint_id = ?, speaker_name = ?
     WHERE id = ?`,
  ).run(
    title !== undefined ? title.trim() : conv.title,
    characterId !== undefined ? characterId : conv.characterId,
    personaId !== undefined ? personaId : conv.personaId,
    endpointId !== undefined ? endpointId : conv.endpointId,
    speakerName !== undefined ? speakerName?.trim() || null : conv.speakerName,
    id,
  );
  invalidate('conversations');
  return getConversation(id);
});

route.del('/api/conversations/:id', ({ params }) => {
  const id = positiveId(params.id);
  getConversation(id);
  stopConversationGenerations(id);
  const doomedImages = collectConversationImages(id);
  stmt('DELETE FROM conversations WHERE id = ?').run(id);
  deleteImageFiles(doomedImages);
  takeDirtyMessageIds(id); // drop pending patch state for the deleted tree
  invalidate('conversations');
});

interface MessageRow {
  id: number;
  parent_id: number | null;
  role: Role;
  content: string;
  reasoning: string | null;
  status: MessageStatus;
  active_child_id: number | null;
  model: string | null;
  gen_meta_json: string | null;
  created_at: number;
  name: string | null;
  generation_kind: GenerationKind;
  images_json: string;
  active_image: number;
  image_render_json: string | null;
}

/**
 * Duplicates a whole conversation: every message row is copied with its tree
 * links (parentId, activeChildId, activeLeafId) remapped through an old-id ->
 * new-id map, and every generated image file is copied so no file is ever
 * shared between two messages (hard-deleting one row would break the other).
 * In-flight generations are copied as plain rows: a 'streaming' status
 * becomes 'stopped' and a pending image render flag is dropped — the copy has
 * no process behind it (same doctrine as the boot repair for stuck rows).
 */
route.post('/api/conversations/:id/duplicate', ({ params }) => {
  const id = positiveId(params.id);
  const conv = getConversation(id);
  // Ordered by id so every parent is inserted before its children.
  const rows = stmt('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id').all(
    id,
  ) as unknown as MessageRow[];
  // Titles follow the 60-char convention of derivedTitle/auto-title.
  const suffix = ' (copy)';
  const title =
    conv.title.length + suffix.length > 60
      ? `${conv.title.slice(0, 60 - suffix.length - 1)}…${suffix}`
      : `${conv.title}${suffix}`;
  const now = Date.now();
  // Image files can't roll back with the SQL: files are created before the
  // commit (so a committed row never references a missing file) and unlinked
  // if anything fails; the startup orphan sweep is the crash-window backstop.
  const writtenImages: string[] = [];
  try {
    const newId = transaction(() => {
      const convResult = stmt(
        `INSERT INTO conversations (title, character_id, persona_id, endpoint_id, speaker_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(title, conv.characterId, conv.personaId, conv.endpointId, conv.speakerName, now, now);
      const newConvId = Number(convResult.lastInsertRowid);
      const idMap = new Map<number, number>();
      for (const row of rows) {
        const images: string[] = [];
        for (const imagePath of JSON.parse(row.images_json) as string[]) {
          const ext = imagePath.includes('.')
            ? imagePath.slice(imagePath.lastIndexOf('.'))
            : '.png';
          const copied = copyImage(imagePath, `msg-dup-${randomUUID()}${ext}`);
          if (copied == null) {
            console.warn(`[conversations] duplicate: source image ${imagePath} is missing`);
            continue;
          }
          writtenImages.push(copied);
          images.push(copied);
        }
        const result = stmt(
          `INSERT INTO messages
             (conversation_id, parent_id, role, content, reasoning, status, active_child_id,
              model, gen_meta_json, created_at, name, generation_kind, images_json, active_image,
              image_pending, image_render_json)
             VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        ).run(
          newConvId,
          // Old databases may contain dangling references (a parent deleted by
          // an ancient bug); remap what we can, null the rest.
          row.parent_id != null ? (idMap.get(row.parent_id) ?? null) : null,
          row.role,
          row.content,
          row.reasoning,
          row.status === 'streaming' ? 'stopped' : row.status,
          row.model,
          row.gen_meta_json,
          row.created_at,
          row.name,
          row.generation_kind,
          JSON.stringify(images),
          images.length > 0 ? Math.min(row.active_image, images.length - 1) : 0,
          row.image_render_json,
        );
        idMap.set(row.id, Number(result.lastInsertRowid));
      }
      // active_child_id can point at a row inserted later than its parent, so
      // it is remapped in a second pass; the conversation's active leaf too.
      // Dangling references (see above) are simply skipped — they stay NULL.
      for (const row of rows) {
        if (row.active_child_id == null) continue;
        const mappedChild = idMap.get(row.active_child_id);
        if (mappedChild == null) continue;
        stmt('UPDATE messages SET active_child_id = ? WHERE id = ?').run(
          mappedChild,
          idMap.get(row.id)!,
        );
      }
      if (conv.activeLeafId != null) {
        const mappedLeaf = idMap.get(conv.activeLeafId);
        if (mappedLeaf != null) {
          stmt('UPDATE conversations SET active_leaf_id = ? WHERE id = ?').run(
            mappedLeaf,
            newConvId,
          );
        }
      }
      return newConvId;
    });
    invalidate('conversations');
    return getConversation(newId);
  } catch (err) {
    deleteImageFiles(writtenImages);
    throw err;
  }
});

route.get('/api/conversations/:id/tree', ({ params }) => {
  const id = positiveId(params.id);
  getConversation(id);
  return treeSnapshot(id);
});

/**
 * Runs a plugin tool prompt as a foreground generation: the output streams
 * into a role='tool' message appended at the active leaf. Tool messages are
 * chat-visible but excluded from future prompt history. The prompt gets the
 * full chat context and is macro-expanded server-side ({{char}}/{{user}}).
 */
route.post('/api/conversations/:id/tool', ({ params, body }) => {
  const id = positiveId(params.id);
  const conv = getConversation(id);
  const b = objectBody(body);
  const prompt = requiredString(b, 'prompt');
  const label = optionalNullableString(b, 'label');
  // Optional image rendering: once the text generation completes, its output
  // is substituted into the ComfyUI workflow and rendered asynchronously.
  let image: { workflow: string; comfyUrl: string } | null = null;
  if (b.image != null) {
    try {
      image = parseImageConfig(b.image);
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
  }
  requireExpectedActiveLeaf(id, optionalNullableId(b, 'expectedActiveLeafId'));
  // An in-flight speculative swipe is deliberately discarded and not refilled:
  // once the tool output is the leaf, the previous reply can't be swiped
  // without a branch switch, which restarts speculation on its own.
  cancelBackgroundSwipe(id);
  if (hasActiveGeneration(id))
    throw new HttpError(409, 'a generation is already running in this conversation');

  // Build from the pre-tool history: the tool message itself must not appear
  // in its own context, and a fixed prompt keeps retries consistent.
  const built = buildToolPrompt(conv, getActivePath(id), prompt);
  const msg = appendMessage(
    id,
    'tool',
    '',
    conv.activeLeafId,
    'streaming',
    null,
    label?.trim() || null,
  );
  // Store the render config (so more alternatives can be generated later) and
  // flag the pending render; finalize() clears the flag if the text generation
  // ends any way other than 'done'.
  if (image) {
    stmt('UPDATE messages SET image_pending = 1, image_render_json = ? WHERE id = ?').run(
      JSON.stringify(image),
      msg.id,
    );
  }
  touchConversation(id);
  broadcastTree(id);
  const renderImage = image;
  startGeneration(getConversation(id), msg.id, undefined, {
    prompt: built,
    onDone: renderImage
      ? () =>
          startImageRender({
            conversationId: id,
            mid: msg.id,
            comfyUrl: renderImage.comfyUrl,
            workflow: renderImage.workflow,
            description: getMessage(msg.id)?.content ?? '',
          })
      : undefined,
  });
  invalidate('conversations');
  return { toolMessageId: msg.id, activeLeafId: msg.id };
});

/** The exact upstream request messages a generation on the current branch would send. */
route.get('/api/conversations/:id/trace', ({ params }) => {
  const conv = getConversation(positiveId(params.id));
  const history = getActivePath(conv.id);
  const { messages, namePrefill } = buildChatMessages(conv, history);
  return { messages, namePrefill };
});

/** Download the full conversation (all branches) as JSON. */
route.get('/api/conversations/:id/export', ({ params, res }) => {
  const conv = getConversation(positiveId(params.id));
  const payload = JSON.stringify(
    { exportedAt: Date.now(), conversation: conv, messages: getTreeMessages(conv.id) },
    null,
    2,
  );
  res
    .writeHead(200, {
      'content-type': 'application/json',
      'content-disposition': `attachment; filename="${conv.title.replace(/[^\w.-]+/g, '_').slice(0, 60)}.json"`,
    })
    .end(payload);
});

/**
 * Search: FTS5 word/prefix match over message contents (with generated
 * snippets), plus a substring match over conversation titles.
 */
route.get('/api/search', ({ req }) => {
  const q = new URL(req.url ?? '/', 'http://x').searchParams.get('q')?.trim() ?? '';
  if (!q) return [];

  // Titles: the query is a literal, not a pattern — escape LIKE wildcards.
  const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
  const titleRows = stmt("SELECT * FROM conversations WHERE title LIKE ? ESCAPE '\\'").all(
    like,
  ) as Record<string, unknown>[];

  // Contents: quote each token as an FTS phrase (user input is not FTS
  // syntax); the last token matches as a prefix for search-as-you-type.
  const tokens = q.split(/\s+/).filter(Boolean);
  const ftsQuery = tokens
    .map((token, i) => `"${token.replaceAll('"', '""')}"${i === tokens.length - 1 ? '*' : ''}`)
    .join(' ');
  // snippet() only works in a plain FTS select (SQLite flattens subqueries,
  // so even a wrapped aggregate breaks) — rank in SQL, dedupe per
  // conversation in JS keeping the best-ranked hit.
  const contentRows = ftsQuery
    ? (stmt(
        `SELECT m.conversation_id AS cid,
                snippet(messages_fts, 0, '', '', '…', 24) AS snip
         FROM messages_fts
         JOIN messages m ON m.id = messages_fts.rowid
         WHERE messages_fts MATCH ?
         ORDER BY rank
         LIMIT 500`,
      ).all(ftsQuery) as { cid: number; snip: string }[])
    : [];
  const snippets = new Map<number, string>();
  for (const row of contentRows) {
    if (!snippets.has(row.cid)) snippets.set(row.cid, row.snip);
  }

  const byId = new Map(titleRows.map((row) => [row.id as number, row]));
  const convById = stmt('SELECT * FROM conversations WHERE id = ?');
  for (const cid of snippets.keys()) {
    if (!byId.has(cid)) {
      const row = convById.get(cid) as Record<string, unknown> | undefined;
      if (row) byId.set(cid, row);
    }
  }
  return [...byId.values()]
    .map(toConversation)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 50)
    .map((conversation) => ({ conversation, snippet: snippets.get(conversation.id) ?? null }));
});

route.post('/api/conversations/:id/messages', ({ params, body }) => {
  const id = positiveId(params.id);
  const conv = getConversation(id);
  const b = objectBody(body);
  const content = requiredString(b, 'content');
  requireExpectedActiveLeaf(id, optionalNullableId(b, 'expectedActiveLeafId'));
  cancelBackgroundSwipe(id);
  if (hasActiveGeneration(id))
    throw new HttpError(409, 'a generation is already running in this conversation');

  const userMsg = appendMessage(id, 'user', content, conv.activeLeafId);
  if (conv.title === 'New chat') {
    stmt('UPDATE conversations SET title = ? WHERE id = ?').run(derivedTitle(content), id);
  }
  const mid = spawnAssistantReply(conv, userMsg.id);
  invalidate('conversations');
  return { userMessageId: userMsg.id, assistantMessageId: mid };
});

/** Delete the active-path tail, including sibling alternatives and every descendant tree. */
route.post('/api/conversations/:id/delete-tail', ({ params, body }) => {
  const id = positiveId(params.id);
  getConversation(id);
  const b = objectBody(body);
  const count = b.count;
  if (!Number.isSafeInteger(count) || (count as number) <= 0) {
    throw new HttpError(400, 'count must be a positive integer');
  }
  requireExpectedActiveLeaf(id, optionalNullableId(b, 'expectedActiveLeafId'));
  const path = getActivePath(id);
  if (path.length === 0) throw new HttpError(400, 'conversation has no messages to delete');
  const cutoff = path[Math.max(0, path.length - (count as number))]!;

  cancelSpeculativeRetries(id);
  stopConversationGenerations(id);
  const doomedImages = collectSiblingSubtreeImages(id, cutoff.parentId);
  const deleted = transaction(() => {
    const result = stmt('DELETE FROM messages WHERE conversation_id = ? AND parent_id IS ?').run(
      id,
      cutoff.parentId,
    );
    setActiveLeaf(id, cutoff.parentId);
    return result.changes;
  });
  deleteImageFiles(doomedImages);
  touchConversation(id);
  broadcastTree(id);
  prepareActiveSwipe(id);
  invalidate('conversations');
  return { activeLeafId: cutoff.parentId, deletedSiblingRoots: deleted };
});
