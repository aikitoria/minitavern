import type { Conversation } from '@minitavern/shared';
import { stmt, toConversation, transaction } from '../db.ts';
import { route, HttpError } from '../router.ts';
import {
  activateMessage,
  appendMessage,
  deleteMessage,
  getActivePath,
  getMessage,
  getTreeMessages,
  setActiveLeaf,
  takeDirtyMessageIds,
} from '../tree.ts';
import { requireReference } from './entityUtils.ts';
import { buildChatMessages, getCharacter, getPersona, substituteMacros } from '../prompt.ts';
import { clearSettingReference, getSettings } from '../settingsStore.ts';
import {
  hasActiveGeneration,
  hasForegroundGeneration,
  startGeneration,
  stopBackgroundGeneration,
  stopConversationGenerations,
} from '../generation.ts';
import { broadcastTree, treeSnapshot } from '../sync.ts';
import { invalidate } from '../events.ts';
import {
  cancelSpeculativeRetries,
  discardSpeculativeSwipes,
  nextUnreadSibling,
  scheduleSpeculativeRetry,
} from '../speculation.ts';
import { requireExpectedActiveLeaf } from '../concurrency.ts';
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
  const mid = stopBackgroundGeneration(conversationId);
  if (mid == null) return false;
  deleteMessage(mid);
  return true;
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
    onDone: () => prepareNextSwipe(speculative.id),
    onError: () => {
      const row = getMessage(speculative.id);
      if (row?.generationKind !== 'speculative') return;
      deleteMessage(speculative.id);
      broadcastTree(conversation.id);
      scheduleSpeculativeRetry(conversation.id, retryAttempt + 1, () =>
        prepareNextSwipe(message.id, retryAttempt + 1),
      );
    },
  });
}

export function prepareActiveSwipe(conversationId: number): void {
  const row = stmt('SELECT active_leaf_id FROM conversations WHERE id = ?').get(conversationId) as
    { active_leaf_id: number | null } | undefined;
  const leaf = row?.active_leaf_id ?? null;
  if (leaf != null) prepareNextSwipe(leaf);
}

/**
 * Creates the empty streaming assistant message and kicks off generation.
 * `speakerName` overrides the conversation's current speaker (e.g. a
 * regeneration keeps the name its siblings were sent with).
 */
export function spawnAssistantReply(
  conversation: Conversation,
  parentId: number | null,
  speakerName: string | null = conversation.speakerName,
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
    onDone: () => prepareNextSwipe(msg.id),
  });
  return msg.id;
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
      const primary = appendMessage(convId, 'assistant', sub(character.firstMessage), null);
      // Imported cards may carry alternate greetings — seed them as root
      // siblings so they're swipeable, with the primary greeting active.
      for (const alt of getAlternateGreetings(character.id)) {
        if (alt.trim()) appendMessage(convId, 'assistant', sub(alt), null);
      }
      activateMessage(primary.id);
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
  if (hasForegroundGeneration(id))
    throw new HttpError(409, 'a generation is already running in this conversation');
  if (contextChanged) discardSpeculativeSwipes(id);
  stmt(
    `UPDATE conversations SET title = ?, character_id = ?, persona_id = ?, endpoint_id = ?, speaker_name = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    title !== undefined ? title.trim() : conv.title,
    characterId !== undefined ? characterId : conv.characterId,
    personaId !== undefined ? personaId : conv.personaId,
    endpointId !== undefined ? endpointId : conv.endpointId,
    speakerName !== undefined ? speakerName?.trim() || null : conv.speakerName,
    Date.now(),
    id,
  );
  invalidate('conversations');
  return getConversation(id);
});

route.del('/api/conversations/:id', ({ params }) => {
  const id = positiveId(params.id);
  getConversation(id);
  stopConversationGenerations(id);
  stmt('DELETE FROM conversations WHERE id = ?').run(id);
  takeDirtyMessageIds(id); // drop pending patch state for the deleted tree
  invalidate('conversations');
});

route.get('/api/conversations/:id/tree', ({ params }) => {
  const id = positiveId(params.id);
  getConversation(id);
  return treeSnapshot(id);
});

route.post('/api/conversations/:id/prepare-swipe', ({ params }) => {
  const id = positiveId(params.id);
  getConversation(id);
  prepareActiveSwipe(id);
  return { prepared: true };
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
    const title = content.length > 60 ? `${content.slice(0, 57)}…` : content;
    stmt('UPDATE conversations SET title = ? WHERE id = ?').run(title, id);
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
  const deleted = transaction(() => {
    const result = stmt('DELETE FROM messages WHERE conversation_id = ? AND parent_id IS ?').run(
      id,
      cutoff.parentId,
    );
    setActiveLeaf(id, cutoff.parentId);
    return result.changes;
  });
  touchConversation(id);
  broadcastTree(id);
  prepareActiveSwipe(id);
  invalidate('conversations');
  return { activeLeafId: cutoff.parentId, deletedSiblingRoots: deleted };
});
