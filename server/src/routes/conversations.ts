import type { Conversation } from '@minitavern/shared';
import { db, toConversation, transaction } from '../db.ts';
import { route, HttpError } from '../router.ts';
import { activateMessage, appendMessage, getActivePath, getTreeMessages } from '../tree.ts';
import { buildChatMessages, getCharacter, getPersona, substituteMacros } from '../prompt.ts';
import { getSettings } from '../settingsStore.ts';
import {
  hasActiveGeneration,
  startGeneration,
  stopConversationGenerations,
} from '../generation.ts';
import { broadcastTree, treeSnapshot } from '../sync.ts';
import { invalidate } from '../events.ts';

export function getConversation(id: number): Conversation {
  const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as
    Record<string, unknown> | undefined;
  if (!row) throw new HttpError(404, `conversation ${id} not found`);
  return toConversation(row);
}

export function touchConversation(id: number): void {
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(Date.now(), id);
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
  broadcastTree(conversation.id);
  startGeneration(getConversation(conversation.id), msg.id);
  return msg.id;
}

function getAlternateGreetings(characterId: number): string[] {
  const row = db.prepare('SELECT card_json FROM characters WHERE id = ?').get(characterId) as
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
  const rows = db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC').all() as Record<
    string,
    unknown
  >[];
  return rows.map(toConversation);
});

route.post('/api/conversations', ({ body }) => {
  const b = (body ?? {}) as { characterId?: number | null };
  const settings = getSettings();
  const character = getCharacter(b.characterId ?? null);
  const now = Date.now();
  const id = transaction(() => {
    const result = db
      .prepare(
        `INSERT INTO conversations (title, character_id, persona_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        character ? character.name : 'New chat',
        character?.id ?? null,
        settings.defaultPersonaId,
        now,
        now,
      );
    const convId = Number(result.lastInsertRowid);
    if (character?.firstMessage.trim()) {
      const persona = getPersona(settings.defaultPersonaId);
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
  const id = Number(params.id);
  const conv = getConversation(id);
  const b = (body ?? {}) as Partial<{
    title: string;
    characterId: number | null;
    personaId: number | null;
    speakerName: string | null;
  }>;
  db.prepare(
    `UPDATE conversations SET title = ?, character_id = ?, persona_id = ?, speaker_name = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    b.title !== undefined ? b.title : conv.title,
    b.characterId !== undefined ? b.characterId : conv.characterId,
    b.personaId !== undefined ? b.personaId : conv.personaId,
    b.speakerName !== undefined ? b.speakerName?.trim() || null : conv.speakerName,
    Date.now(),
    id,
  );
  invalidate('conversations');
  return getConversation(id);
});

route.del('/api/conversations/:id', ({ params }) => {
  const id = Number(params.id);
  getConversation(id);
  stopConversationGenerations(id);
  db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
  invalidate('conversations');
});

route.get('/api/conversations/:id/tree', ({ params }) => {
  const id = Number(params.id);
  getConversation(id);
  return treeSnapshot(id);
});

/** The exact upstream request messages a generation on the current branch would send. */
route.get('/api/conversations/:id/trace', ({ params }) => {
  const conv = getConversation(Number(params.id));
  const history = getActivePath(conv.id);
  const { messages, namePrefill } = buildChatMessages(conv, history);
  return { messages, namePrefill };
});

/** Download the full conversation (all branches) as JSON. */
route.get('/api/conversations/:id/export', ({ params, res }) => {
  const conv = getConversation(Number(params.id));
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

/** Search conversation titles and message contents. */
route.get('/api/search', ({ req }) => {
  const q = new URL(req.url ?? '/', 'http://x').searchParams.get('q')?.trim() ?? '';
  if (!q) return [];
  const like = `%${q}%`;
  const convRows = db
    .prepare(
      `SELECT DISTINCT c.* FROM conversations c
       LEFT JOIN messages m ON m.conversation_id = c.id
       WHERE c.title LIKE ?1 OR m.content LIKE ?1
       ORDER BY c.updated_at DESC LIMIT 50`,
    )
    .all(like) as Record<string, unknown>[];
  const snippetStmt = db.prepare(
    'SELECT content FROM messages WHERE conversation_id = ? AND content LIKE ? ORDER BY id DESC LIMIT 1',
  );
  return convRows.map((row) => {
    const conv = toConversation(row);
    const match = snippetStmt.get(conv.id, like) as { content: string } | undefined;
    let snippet: string | null = null;
    if (match) {
      const idx = match.content.toLowerCase().indexOf(q.toLowerCase());
      const start = Math.max(0, idx - 32);
      snippet =
        (start > 0 ? '…' : '') +
        match.content.slice(start, idx + q.length + 48) +
        (idx + q.length + 48 < match.content.length ? '…' : '');
    }
    return { conversation: conv, snippet };
  });
});

route.post('/api/conversations/:id/messages', ({ params, body }) => {
  const id = Number(params.id);
  const conv = getConversation(id);
  const b = (body ?? {}) as { content?: string };
  const content = (b.content ?? '').trim();
  if (!content) throw new HttpError(400, 'content is required');
  if (hasActiveGeneration(id))
    throw new HttpError(409, 'a generation is already running in this conversation');

  const userMsg = appendMessage(id, 'user', content, conv.activeLeafId);
  if (conv.title === 'New chat') {
    const title = content.length > 60 ? `${content.slice(0, 57)}…` : content;
    db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title, id);
  }
  const mid = spawnAssistantReply(conv, userMsg.id);
  invalidate('conversations');
  return { userMessageId: userMsg.id, assistantMessageId: mid };
});
