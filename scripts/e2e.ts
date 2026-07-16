// End-to-end test against a running dev stack (server + mock).
// Run: docker compose -f docker-compose.dev.yml run --rm --no-deps server node scripts/e2e.ts
import { deflateSync } from 'node:zlib';
import type { Message, ServerEvent, TreeSnapshot } from '@minitavern/shared';

const BASE = process.env.E2E_BASE ?? 'http://server:5487';
const MOCK_URL = process.env.E2E_MOCK ?? 'http://mock:9800/v1';

let passed = 0;

function assert(cond: unknown, label: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${label}`);
  passed++;
  console.log(`  ok: ${label}`);
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${await res.text()}`);
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

class WsClient {
  events: ServerEvent[] = [];
  private ws: WebSocket;
  private waiters: { pred: (ev: ServerEvent) => boolean; resolve: (ev: ServerEvent) => void }[] =
    [];

  constructor() {
    this.ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws`);
    this.ws.onmessage = (event: MessageEvent) => {
      const ev = JSON.parse(event.data as string) as ServerEvent;
      this.events.push(ev);
      this.waiters = this.waiters.filter((w) => {
        if (w.pred(ev)) {
          w.resolve(ev);
          return false;
        }
        return true;
      });
    };
  }

  async open(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e: Event) => reject(new Error(`ws error: ${String(e)}`));
    });
  }

  sub(conversationId: number): void {
    this.ws.send(JSON.stringify({ sub: conversationId }));
  }

  waitFor(
    pred: (ev: ServerEvent) => boolean,
    label: string,
    timeoutMs = 15000,
  ): Promise<ServerEvent> {
    const existing = this.events.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for: ${label}`)), timeoutMs);
      this.waiters.push({
        pred,
        resolve: (ev) => {
          clearTimeout(timer);
          resolve(ev);
        },
      });
    });
  }

  close(): void {
    this.ws.close();
  }
}

function crcTable(): Uint32Array {
  return new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
}

function makeCardPng(): Buffer {
  // 1x1 PNG with a tEXt 'chara' chunk carrying a V2 card.
  const table = crcTable();
  const crc32 = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const byte of buf) c = table[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(head.length + 8);
    out.writeUInt32BE(data.length, 0);
    head.copy(out, 4);
    out.writeUInt32BE(crc32(head), head.length + 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const card = {
    spec: 'chara_card_v2',
    data: {
      name: 'Card Imported Hero',
      description: 'A brave test subject.',
      personality: 'Fearless and pixelated.',
      scenario: 'Inside a unit test.',
      first_mes: 'Greetings, {{user}}! I am {{char}}.',
      alternate_greetings: ['Alternate hello, {{user}}!'],
    },
  };
  const text = Buffer.concat([
    Buffer.from('chara', 'latin1'),
    Buffer.from([0]),
    Buffer.from(Buffer.from(JSON.stringify(card), 'utf8').toString('base64'), 'latin1'),
  ]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('tEXt', text),
    chunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 0, 0]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const tree = (id: number) => req<TreeSnapshot>('GET', `/api/conversations/${id}/tree`);

function pathOf(snapshot: TreeSnapshot): Message[] {
  const byId = new Map(snapshot.messages.map((m) => [m.id, m]));
  const path: Message[] = [];
  let cur = snapshot.activeLeafId;
  while (cur != null) {
    const msg = byId.get(cur)!;
    path.push(msg);
    cur = msg.parentId;
  }
  return path.reverse();
}

async function main() {
  console.log('== setup: endpoint, models, settings ==');
  const endpoint = await req<{ id: number }>('POST', '/api/endpoints', {
    name: 'mock',
    baseUrl: MOCK_URL,
    apiKey: 'test-key',
  });
  const models = await req<string[]>('GET', `/api/endpoints/${endpoint.id}/models`);
  assert(models.includes('mock-large'), 'model list fetched from upstream');
  await req('PATCH', `/api/endpoints/${endpoint.id}`, { model: 'mock-large' });
  await req('PUT', '/api/settings', { activeEndpointId: endpoint.id });

  console.log('== persona + preset + macro substitution ==');
  const persona = await req<{ id: number }>('POST', '/api/personas', {
    name: 'Aiki',
    description: 'A performance-obsessed developer.',
  });
  const preset = await req<{ id: number }>('POST', '/api/presets', {
    name: 'Test preset',
    content: 'You are {{char}} speaking with {{user}}.',
  });
  await req('PUT', '/api/settings', { defaultPersonaId: persona.id, defaultPresetId: preset.id });

  console.log('== core chat loop with streaming ==');
  const conv = await req<{ id: number }>('POST', '/api/conversations', { characterId: null });
  const ws = new WsClient();
  await ws.open();
  ws.sub(conv.id);
  await ws.waitFor((e) => e.t === 'tree', 'initial tree push');

  await req('POST', `/api/conversations/${conv.id}/messages`, { content: 'Hello world' });
  await ws.waitFor((e) => e.t === 'final', 'first generation finished');
  const deltas = ws.events.filter((e) => e.t === 'delta');
  assert(deltas.length > 10, `stream relayed incrementally (${deltas.length} delta frames)`);
  assert(
    ws.events.some((e) => e.t === 'delta' && 'r' in e && e.r),
    'reasoning deltas relayed',
  );

  let snap = await tree(conv.id);
  let path = pathOf(snap);
  assert(path.length === 2, 'path is [user, assistant]');
  assert(
    path[1]!.status === 'done' && path[1]!.content.includes('Hello world'),
    'assistant reply persisted',
  );
  assert(
    path[1]!.content.includes('You are Assistant speaking with Aiki.'),
    'macros substituted in system prompt',
  );
  assert(path[1]!.reasoning != null && path[1]!.reasoning.length > 0, 'reasoning persisted');
  const userMsg1 = path[0]!;
  const assistant1 = path[1]!;

  // Verify streamed content equals persisted content.
  const streamed = deltas.map((e) => (e.t === 'delta' ? (e.d ?? '') : '')).join('');
  assert(streamed === assistant1.content, 'concatenated deltas equal persisted content');

  console.log('== regenerate creates sibling ==');
  await req('POST', `/api/messages/${assistant1.id}/regenerate`);
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id !== assistant1.id,
    'regeneration finished',
  );
  snap = await tree(conv.id);
  const assistantSiblings = snap.messages.filter((m) => m.parentId === userMsg1.id);
  assert(assistantSiblings.length === 2, 'two assistant siblings after regenerate');
  const assistant2 = assistantSiblings.find((m) => m.id !== assistant1.id)!;
  assert(snap.activeLeafId === assistant2.id, 'new sibling is active');

  console.log('== extend branch on first sibling, then deep-restore ==');
  await req('POST', `/api/messages/${assistant1.id}/activate`);
  snap = await tree(conv.id);
  assert(snap.activeLeafId === assistant1.id, 'branch switch back to first reply');

  await req('POST', `/api/conversations/${conv.id}/messages`, { content: 'Second question' });
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.parentId != null && e.message.parentId !== userMsg1.id,
    'reply to second question',
  );
  snap = await tree(conv.id);
  path = pathOf(snap);
  assert(path.length === 4, 'path deepened to 4 under first sibling');
  const deepLeafId = snap.activeLeafId!;

  // Switch to sibling 2 (short branch), then back to sibling 1: the deep chain must be restored.
  await req('POST', `/api/messages/${assistant2.id}/activate`);
  snap = await tree(conv.id);
  assert(snap.activeLeafId === assistant2.id, 'switched to short branch');
  await req('POST', `/api/messages/${assistant1.id}/activate`);
  snap = await tree(conv.id);
  assert(snap.activeLeafId === deepLeafId, 'deep chain restored after switching back');

  console.log('== edit user message as branch (root fork), then restore ==');
  await req('POST', `/api/messages/${userMsg1.id}/edit-branch`, { content: 'Edited hello' });
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.content.includes('Edited hello'),
    'generation for edited branch',
  );
  snap = await tree(conv.id);
  path = pathOf(snap);
  assert(
    path.length === 2 && path[0]!.content === 'Edited hello',
    'edited branch active with fresh reply',
  );
  const roots = snap.messages.filter((m) => m.parentId === null);
  assert(roots.length === 2, 'two root siblings after root edit');

  await req('POST', `/api/messages/${userMsg1.id}/activate`);
  snap = await tree(conv.id);
  assert(snap.activeLeafId === deepLeafId, 'full original chain restored across the root fork');

  console.log('== in-place edit ==');
  await req('PATCH', `/api/messages/${assistant1.id}`, { content: 'Rewritten reply.' });
  snap = await tree(conv.id);
  assert(
    snap.messages.find((m) => m.id === assistant1.id)!.content === 'Rewritten reply.',
    'in-place edit persisted',
  );

  console.log('== stop mid-generation ==');
  const sendResult = await req<{ assistantMessageId: number }>(
    'POST',
    `/api/conversations/${conv.id}/messages`,
    { content: 'Long answer please' },
  );
  await ws.waitFor(
    (e) => e.t === 'delta' && e.mid === sendResult.assistantMessageId,
    'stream started',
  );
  await req('POST', `/api/generations/${sendResult.assistantMessageId}/stop`);
  const stopped = await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === sendResult.assistantMessageId,
    'stopped finalization',
  );
  assert(stopped.t === 'final' && stopped.message.status === 'stopped', 'message marked stopped');

  console.log('== mid-stream subscriber gets snapshot + remaining deltas ==');
  const send2 = await req<{ assistantMessageId: number }>(
    'POST',
    `/api/conversations/${conv.id}/messages`,
    { content: 'Another one' },
  );
  await ws.waitFor(
    (e) => e.t === 'delta' && e.mid === send2.assistantMessageId,
    'second stream started',
  );
  const ws2 = new WsClient();
  await ws2.open();
  ws2.sub(conv.id);
  const treeEv = await ws2.waitFor((e) => e.t === 'tree', 'late-joiner tree snapshot');
  const finalEv = await ws2.waitFor(
    (e) => e.t === 'final' && e.message.id === send2.assistantMessageId,
    'late-joiner sees final',
  );
  if (treeEv.t !== 'tree' || finalEv.t !== 'final') throw new Error('unreachable');
  const snapshotContent = treeEv.messages.find((m) => m.id === send2.assistantMessageId)!.content;
  const lateDeltas = ws2.events
    .filter((e) => e.t === 'delta' && e.mid === send2.assistantMessageId)
    .map((e) => (e.t === 'delta' ? (e.d ?? '') : ''))
    .join('');
  assert(
    snapshotContent + lateDeltas === finalEv.message.content,
    'late-joiner snapshot + deltas reconstruct the full message',
  );
  ws2.close();

  console.log('== delete prunes subtree ==');
  snap = await tree(conv.id);
  const before = snap.messages.length;
  await req('DELETE', `/api/messages/${send2.assistantMessageId}`);
  snap = await tree(conv.id);
  assert(snap.messages.length === before - 1, 'message deleted');
  assert(snap.activeLeafId !== send2.assistantMessageId, 'active leaf repaired');

  console.log('== character card import + greeting seeding ==');
  const cardRes = await fetch(`${BASE}/api/characters/import-card`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: new Uint8Array(makeCardPng()),
  });
  if (!cardRes.ok) throw new Error(`card import failed: ${await cardRes.text()}`);
  const character = (await cardRes.json()) as {
    id: number;
    name: string;
    personality: string;
    scenario: string;
    avatar: string | null;
  };
  assert(character.name === 'Card Imported Hero', 'card name imported');
  assert(
    character.personality.includes('brave') && character.personality.includes('Fearless'),
    'description + personality merged',
  );
  assert(character.avatar != null, 'card PNG stored as avatar');
  const avatarRes = await fetch(`${BASE}${character.avatar}`);
  assert(avatarRes.ok, 'avatar served');

  const charConv = await req<{ id: number; title: string }>('POST', '/api/conversations', {
    characterId: character.id,
  });
  const charSnap = await tree(charConv.id);
  const greeting = pathOf(charSnap)[0]!;
  assert(
    greeting.role === 'assistant' &&
      greeting.content === 'Greetings, Aiki! I am Card Imported Hero.',
    'first message seeded with macros substituted',
  );
  assert(charConv.title === 'Card Imported Hero', 'conversation titled after character');
  const greetingRoots = charSnap.messages.filter((m) => m.parentId === null);
  assert(greetingRoots.length === 2, 'alternate greeting seeded as root sibling');
  assert(
    greetingRoots.some((m) => m.content === 'Alternate hello, Aiki!'),
    'alternate greeting macros substituted',
  );

  console.log('== character card export round-trip ==');
  const exportRes = await fetch(`${BASE}/api/characters/${character.id}/card`);
  assert(
    exportRes.ok && exportRes.headers.get('content-type') === 'image/png',
    'card export returns PNG',
  );
  const reimportRes = await fetch(`${BASE}/api/characters/import-card`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: new Uint8Array(await exportRes.arrayBuffer()),
  });
  const reimported = (await reimportRes.json()) as { name: string; personality: string };
  assert(reimported.name === 'Card Imported Hero', 'exported card reimports with same name');
  assert(reimported.personality.includes('brave'), 'exported card keeps personality text');

  console.log('== templates: prologue, name prefixing, /char, resume ==');
  const tpl = await req<{ id: number }>('POST', '/api/templates', {
    name: 'e2e-prefix',
    content: '{{system}}',
    userPrologue: 'You are playing {{char}}.',
    prefixNames: true,
  });
  const prevSettings = await req<{ defaultTemplateId: number | null }>('GET', '/api/settings');
  await req('PUT', '/api/settings', { defaultTemplateId: tpl.id });
  const conv2 = await req<{ id: number }>('POST', '/api/conversations', {});
  await req('PATCH', `/api/conversations/${conv2.id}`, { speakerName: 'Ari' });

  const trace = await req<{
    messages: { role: string; content: string }[];
    namePrefill: string | null;
  }>('GET', `/api/conversations/${conv2.id}/trace`);
  assert(
    trace.messages.some((m) => m.role === 'user' && m.content === 'You are playing Assistant.'),
    'template prologue emitted as fake user turn',
  );
  assert(trace.namePrefill === 'Ari:', 'name prefill uses the /char speaker');

  ws.sub(conv2.id);
  const sent = await req<{ assistantMessageId: number }>(
    'POST',
    `/api/conversations/${conv2.id}/messages`,
    { content: 'prefix check' },
  );
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === sent.assistantMessageId,
    'prefixed generation finished',
  );
  let snap2 = await tree(conv2.id);
  const reply = snap2.messages.find((m) => m.id === sent.assistantMessageId)!;
  assert(reply.name === 'Ari', 'reply stamped with the /char speaker name');
  assert(
    reply.content.includes('Aiki: prefix check'),
    'history prefixed with persona name upstream',
  );

  await req('PATCH', `/api/conversations/${conv2.id}`, { speakerName: 'Bob' });
  const regen = await req<{ assistantMessageId: number }>(
    'POST',
    `/api/messages/${sent.assistantMessageId}/regenerate`,
  );
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === regen.assistantMessageId,
    'regeneration finished',
  );
  snap2 = await tree(conv2.id);
  assert(
    snap2.messages.find((m) => m.id === regen.assistantMessageId)!.name === 'Ari',
    'regeneration keeps the original speaker name',
  );

  const beforeResume = snap2.messages.find((m) => m.id === regen.assistantMessageId)!.content
    .length;
  await req('POST', `/api/messages/${regen.assistantMessageId}/continue`);
  await ws.waitFor(
    (e) =>
      e.t === 'final' &&
      e.message.id === regen.assistantMessageId &&
      e.message.content.length > beforeResume &&
      e.message.status === 'done',
    'resume appended to the same message',
  );

  await req('PUT', '/api/settings', { defaultTemplateId: prevSettings.defaultTemplateId });

  console.log('== conversation search ==');
  const found = await req<{ conversation: { id: number }; snippet: string | null }[]>(
    'GET',
    `/api/search?q=${encodeURIComponent('prefix check')}`,
  );
  assert(
    found.some((r) => r.conversation.id === conv2.id && r.snippet?.includes('prefix check')),
    'search finds conversation by message content with snippet',
  );

  ws.close();
  console.log(`\nALL ${passed} ASSERTIONS PASSED`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
