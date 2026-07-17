// End-to-end test against a running dev stack (server + mock).
// Run: docker compose -f docker-compose.dev.yml run --rm --no-deps server node scripts/e2e.ts
import { deflateSync } from 'node:zlib';
import type { Message, ServerEvent, Settings, TreeSnapshot } from '@minitavern/shared';

const BASE = process.env.E2E_BASE ?? 'http://server:5487';
const MOCK_URL = process.env.E2E_MOCK ?? 'http://mock:9800/v1';
const MOCK_CONTROL = MOCK_URL.replace(/\/v1\/?$/, '');

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

async function expectStatus(
  method: string,
  path: string,
  body: unknown,
  status: number,
): Promise<void> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert(res.status === status, `${method} ${path} rejects invalid input with ${status}`);
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

  sendRaw(value: unknown): void {
    this.ws.send(JSON.stringify(value));
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

function makeCompressedMetadataBombPng(): Buffer {
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
  const metadata = Buffer.concat([
    Buffer.from('chara\0', 'latin1'),
    Buffer.from([1, 0, 0, 0]),
    deflateSync(Buffer.alloc(9 * 1024 * 1024, 0x41)),
  ]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('iTXt', metadata),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const tree = (id: number) => req<TreeSnapshot>('GET', `/api/conversations/${id}/tree`);

async function branchBody(conversationId: number, body: Record<string, unknown> = {}) {
  const snapshot = await tree(conversationId);
  return { ...body, expectedActiveLeafId: snapshot.activeLeafId };
}

const sendMessage = async (conversationId: number, content: string) =>
  req<{ userMessageId: number; assistantMessageId: number }>(
    'POST',
    `/api/conversations/${conversationId}/messages`,
    await branchBody(conversationId, { content }),
  );

const activate = async (conversationId: number, messageId: number) =>
  req('POST', `/api/messages/${messageId}/activate`, await branchBody(conversationId));

async function failNextMockRequests(count: number): Promise<void> {
  const res = await fetch(`${MOCK_CONTROL}/control/fail-next?count=${count}`, { method: 'POST' });
  if (!res.ok) throw new Error(`could not configure mock failures: ${await res.text()}`);
}

async function makeNextMockResponseEndWithoutNewline(): Promise<void> {
  const res = await fetch(`${MOCK_CONTROL}/control/terminal-without-newline`, { method: 'POST' });
  if (!res.ok) throw new Error(`could not configure terminal mock event: ${await res.text()}`);
}

async function putSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await req<Settings>('GET', '/api/settings');
  return req<Settings>('PUT', '/api/settings', {
    ...patch,
    expectedRevision: current.revision,
  });
}

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
  const publicEndpoint = (
    await req<{ id: number; apiKey: string; hasApiKey: boolean }[]>('GET', '/api/endpoints')
  ).find((candidate) => candidate.id === endpoint.id)!;
  assert(
    publicEndpoint.apiKey === '' && publicEndpoint.hasApiKey,
    'endpoint API responses redact stored secrets',
  );
  const models = await req<string[]>('GET', `/api/endpoints/${endpoint.id}/models`);
  assert(models.includes('mock-large'), 'model list fetched from upstream');
  await req('PATCH', `/api/endpoints/${endpoint.id}`, { model: 'mock-large' });
  await putSettings({ activeEndpointId: endpoint.id });

  console.log('== shared settings reject stale device writes ==');
  const settingsBase = await req<Settings>('GET', '/api/settings');
  await req<Settings>('PUT', '/api/settings', {
    autoExpandThinking: true,
    expectedRevision: settingsBase.revision,
  });
  await expectStatus(
    'PUT',
    '/api/settings',
    { autoExpandThinking: false, expectedRevision: settingsBase.revision },
    409,
  );
  await putSettings({ autoExpandThinking: false });

  console.log('== persona + preset + macro substitution ==');
  const persona = await req<{ id: number }>('POST', '/api/personas', {
    name: 'Aiki',
    description: 'A performance-obsessed developer.',
  });
  const preset = await req<{ id: number }>('POST', '/api/presets', {
    name: 'Test preset',
    content: 'You are {{char}} speaking with {{user}}.',
  });
  await putSettings({ defaultPersonaId: persona.id, defaultPresetId: preset.id });

  console.log('== stale defaults and request validation ==');
  const disposablePersona = await req<{ id: number }>('POST', '/api/personas', {
    name: 'Disposable default',
  });
  await putSettings({ defaultPersonaId: disposablePersona.id });
  await req('DELETE', `/api/personas/${disposablePersona.id}`);
  const settingsAfterDelete = await req<{ defaultPersonaId: number | null }>(
    'GET',
    '/api/settings',
  );
  assert(
    settingsAfterDelete.defaultPersonaId === null,
    'deleting a default persona clears settings',
  );
  const noPersonaConv = await req<{ personaId: number | null }>('POST', '/api/conversations', {});
  assert(
    noPersonaConv.personaId === null,
    'conversation creation survives a deleted default persona',
  );
  await putSettings({ defaultPersonaId: persona.id });
  await expectStatus('PATCH', `/api/personas/${persona.id}`, { name: '   ' }, 400);
  await expectStatus(
    'PUT',
    '/api/settings',
    {
      defaultPersonaId: 999999999,
      expectedRevision: (await req<Settings>('GET', '/api/settings')).revision,
    },
    400,
  );

  console.log('== core chat loop with streaming ==');
  const conv = await req<{ id: number }>('POST', '/api/conversations', { characterId: null });
  const ws = new WsClient();
  await ws.open();
  ws.sendRaw(null);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await req('GET', '/api/settings');
  assert(true, 'malformed WebSocket command does not crash the server');
  ws.sub(conv.id);
  await ws.waitFor((e) => e.t === 'tree', 'initial tree push');
  const peer = new WsClient();
  await peer.open();
  peer.sub(conv.id);
  await peer.waitFor(
    (e) => e.t === 'tree' && e.conversationId === conv.id,
    'second frontend initial tree',
  );

  const firstSend = await sendMessage(conv.id, '  Hello world  ');
  const [firstFinal, peerFinal] = await Promise.all([
    ws.waitFor(
      (e) => e.t === 'final' && e.message.id === firstSend.assistantMessageId,
      'first generation finished',
    ),
    peer.waitFor(
      (e) => e.t === 'final' && e.message.id === firstSend.assistantMessageId,
      'second frontend sees first generation finish',
    ),
  ]);
  assert(
    firstFinal.t === 'final' &&
      peerFinal.t === 'final' &&
      firstFinal.message.content === peerFinal.message.content &&
      peer.events.some(
        (event) => event.t === 'delta' && event.mid === firstSend.assistantMessageId,
      ),
    'two frontends receive the same streamed response',
  );
  peer.close();
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
  assert(userMsg1.content === 'Hello world', 'message boundaries are trimmed on write/read');
  await expectStatus(
    'POST',
    `/api/conversations/${conv.id}/messages`,
    { content: 'stale send', expectedActiveLeafId: null },
    409,
  );
  await expectStatus('PATCH', `/api/conversations/${conv.id}`, { personaId: 999999999 }, 400);

  // Verify streamed content equals persisted content.
  const streamed = deltas.map((e) => (e.t === 'delta' ? (e.d ?? '') : '')).join('');
  assert(streamed === assistant1.content, 'concatenated deltas equal persisted content');

  console.log('== advancing past the last swipe creates a sibling ==');
  await req('POST', `/api/messages/${assistant1.id}/advance`, await branchBody(conv.id));
  await ws.waitFor((e) => e.t === 'final' && e.message.id !== assistant1.id, 'new swipe finished');
  snap = await tree(conv.id);
  const assistantSiblings = snap.messages.filter((m) => m.parentId === userMsg1.id);
  assert(assistantSiblings.length === 2, 'two assistant siblings after advancing');
  const assistant2 = assistantSiblings.find((m) => m.id !== assistant1.id)!;
  assert(snap.activeLeafId === assistant2.id, 'new sibling is active');
  await expectStatus('POST', `/api/messages/${assistant2.id}/regenerate`, undefined, 404);

  console.log('== extend branch on first sibling, then deep-restore ==');
  await activate(conv.id, assistant1.id);
  snap = await tree(conv.id);
  assert(snap.activeLeafId === assistant1.id, 'branch switch back to first reply');

  await sendMessage(conv.id, 'Second question');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.parentId != null && e.message.parentId !== userMsg1.id,
    'reply to second question',
  );
  snap = await tree(conv.id);
  path = pathOf(snap);
  assert(path.length === 4, 'path deepened to 4 under first sibling');
  const deepLeafId = snap.activeLeafId!;

  // Switch to sibling 2 (short branch), then back to sibling 1: the deep chain must be restored.
  await activate(conv.id, assistant2.id);
  snap = await tree(conv.id);
  assert(snap.activeLeafId === assistant2.id, 'switched to short branch');
  await activate(conv.id, assistant1.id);
  snap = await tree(conv.id);
  assert(snap.activeLeafId === deepLeafId, 'deep chain restored after switching back');

  console.log('== edit user message as branch (root fork), then restore ==');
  await req(
    'POST',
    `/api/messages/${userMsg1.id}/edit-branch`,
    await branchBody(conv.id, { content: 'Edited hello' }),
  );
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

  await activate(conv.id, userMsg1.id);
  snap = await tree(conv.id);
  assert(snap.activeLeafId === deepLeafId, 'full original chain restored across the root fork');

  console.log('== in-place edit ==');
  await expectStatus(
    'PATCH',
    `/api/messages/${assistant1.id}`,
    { content: '   ', expectedActiveLeafId: snap.activeLeafId },
    400,
  );
  await req(
    'PATCH',
    `/api/messages/${assistant1.id}`,
    await branchBody(conv.id, { content: 'Rewritten reply.' }),
  );
  snap = await tree(conv.id);
  assert(
    snap.messages.find((m) => m.id === assistant1.id)!.content === 'Rewritten reply.',
    'in-place edit persisted',
  );

  console.log('== swipe past an in-flight generation ==');
  const sendResult = await sendMessage(conv.id, 'Long answer please');
  await ws.waitFor(
    (e) => e.t === 'delta' && e.mid === sendResult.assistantMessageId,
    'stream started',
  );
  await expectStatus(
    'DELETE',
    `/api/messages/${sendResult.userMessageId}?expectedActiveLeafId=${sendResult.assistantMessageId}`,
    undefined,
    409,
  );
  await expectStatus(
    'PATCH',
    `/api/messages/${sendResult.userMessageId}`,
    {
      content: 'changed while streaming',
      expectedActiveLeafId: sendResult.assistantMessageId,
    },
    409,
  );
  const nextSwipe = await req<{ assistantMessageId: number | null }>(
    'POST',
    `/api/messages/${sendResult.assistantMessageId}/advance`,
    { expectedActiveLeafId: sendResult.assistantMessageId },
  );
  if (nextSwipe.assistantMessageId == null) throw new Error('expected a generated swipe');
  const replaced = await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === sendResult.assistantMessageId,
    'swiped-past generation stopped',
  );
  assert(
    replaced.t === 'final' && replaced.message.status === 'stopped',
    'swiping further stops and preserves the partial reply',
  );
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === nextSwipe.assistantMessageId,
    'next swipe generation finished',
  );

  console.log('== stop mid-generation ==');
  const stoppedSend = await sendMessage(conv.id, 'Stop this answer');
  await ws.waitFor(
    (e) => e.t === 'delta' && e.mid === stoppedSend.assistantMessageId,
    'stoppable stream started',
  );
  await req('POST', `/api/generations/${stoppedSend.assistantMessageId}/stop`);
  const stopped = await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === stoppedSend.assistantMessageId,
    'stopped finalization',
  );
  assert(stopped.t === 'final' && stopped.message.status === 'stopped', 'message marked stopped');

  console.log('== mid-stream subscriber gets snapshot + remaining deltas ==');
  const send2 = await sendMessage(conv.id, 'Another one');
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
  await req(
    'DELETE',
    `/api/messages/${send2.assistantMessageId}?expectedActiveLeafId=${snap.activeLeafId}`,
  );
  snap = await tree(conv.id);
  assert(snap.messages.length === before - 1, 'message deleted');
  assert(snap.activeLeafId !== send2.assistantMessageId, 'active leaf repaired');

  console.log('== delete-tail removes sibling swipes and descendant trees ==');
  const tailConv = await req<{ id: number }>('POST', '/api/conversations', {});
  ws.sub(tailConv.id);
  await ws.waitFor(
    (e) => e.t === 'tree' && e.conversationId === tailConv.id,
    'delete-tail conversation tree',
  );
  const tailFirst = await sendMessage(tailConv.id, 'tail root');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === tailFirst.assistantMessageId,
    'delete-tail first reply',
  );
  const oldBranch = await sendMessage(tailConv.id, 'old branch descendant');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === oldBranch.assistantMessageId,
    'delete-tail old descendant reply',
  );
  const sibling = await req<{ assistantMessageId: number | null }>(
    'POST',
    `/api/messages/${tailFirst.assistantMessageId}/advance`,
    await branchBody(tailConv.id),
  );
  if (sibling.assistantMessageId == null) throw new Error('expected a fresh sibling swipe');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === sibling.assistantMessageId,
    'delete-tail sibling reply',
  );
  const newBranch = await sendMessage(tailConv.id, 'new branch descendant');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === newBranch.assistantMessageId,
    'delete-tail new descendant reply',
  );
  const tailBefore = await tree(tailConv.id);
  await expectStatus(
    'POST',
    `/api/conversations/${tailConv.id}/delete-tail`,
    { count: 3, expectedActiveLeafId: tailFirst.assistantMessageId },
    409,
  );
  const tailDeleted = await req<{ activeLeafId: number | null; deletedSiblingRoots: number }>(
    'POST',
    `/api/conversations/${tailConv.id}/delete-tail`,
    { count: 3, expectedActiveLeafId: tailBefore.activeLeafId },
  );
  const tailAfter = await tree(tailConv.id);
  assert(
    tailDeleted.deletedSiblingRoots === 2 &&
      tailAfter.activeLeafId === tailFirst.userMessageId &&
      tailAfter.messages.length === 1 &&
      tailAfter.messages[0]!.id === tailFirst.userMessageId,
    'tail deletion removes all swipes at the cutoff and both descendant trees',
  );
  await req('POST', `/api/conversations/${tailConv.id}/delete-tail`, {
    count: 99,
    expectedActiveLeafId: tailAfter.activeLeafId,
  });
  assert((await tree(tailConv.id)).messages.length === 0, 'large tail count clears the whole tree');

  console.log('== character card import + greeting seeding ==');
  const bombRes = await fetch(`${BASE}/api/characters/import-card`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: new Uint8Array(makeCompressedMetadataBombPng()),
  });
  assert(bombRes.status === 400, 'oversized compressed PNG metadata is rejected safely');
  await req('GET', '/api/settings');
  assert(true, 'server remains responsive after compressed metadata rejection');
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
  await putSettings({ defaultTemplateId: tpl.id });
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
  const sent = await sendMessage(conv2.id, '  prefix check  ');
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
  const prefixedTrace = await req<{
    messages: { role: string; content: string }[];
    namePrefill: string | null;
  }>('GET', `/api/conversations/${conv2.id}/trace`);
  assert(
    prefixedTrace.messages.some((message) => message.content === 'Aiki: prefix check') &&
      prefixedTrace.namePrefill === 'Ari:',
    'name prefixes use one space and prefills have no trailing space',
  );

  await req('PATCH', `/api/conversations/${conv2.id}`, { speakerName: 'Bob' });
  const regen = await req<{ assistantMessageId: number | null }>(
    'POST',
    `/api/messages/${sent.assistantMessageId}/advance`,
    await branchBody(conv2.id),
  );
  if (regen.assistantMessageId == null) throw new Error('expected a newly generated swipe');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === regen.assistantMessageId,
    'speaker-preserving swipe finished',
  );
  snap2 = await tree(conv2.id);
  assert(
    snap2.messages.find((m) => m.id === regen.assistantMessageId)!.name === 'Ari',
    'a new swipe keeps the original speaker name',
  );

  const beforeResume = snap2.messages.find((m) => m.id === regen.assistantMessageId)!.content
    .length;
  await req(
    'POST',
    `/api/messages/${regen.assistantMessageId}/continue`,
    await branchBody(conv2.id),
  );
  await ws.waitFor(
    (e) =>
      e.t === 'final' &&
      e.message.id === regen.assistantMessageId &&
      e.message.content.length > beforeResume &&
      e.message.status === 'done',
    'resume appended to the same message',
  );

  await putSettings({ defaultTemplateId: prevSettings.defaultTemplateId });

  console.log('== terminal SSE data without a newline is preserved ==');
  await makeNextMockResponseEndWithoutNewline();
  const terminalSend = await sendMessage(conv2.id, 'terminal SSE event');
  const terminalFinal = await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === terminalSend.assistantMessageId,
    'terminal SSE generation finished',
  );
  assert(
    terminalFinal.t === 'final' && terminalFinal.message.content.endsWith('TERMINAL_NO_NEWLINE'),
    'final unterminated SSE event is persisted',
  );

  console.log('== background swipe generation stays one reply ahead ==');
  await putSettings({ backgroundSwipeGeneration: false });
  const backgroundConv = await req<{ id: number }>('POST', '/api/conversations', {});
  ws.sub(backgroundConv.id);
  await ws.waitFor(
    (e) => e.t === 'tree' && e.conversationId === backgroundConv.id,
    'background-swipe conversation tree',
  );
  const backgroundSend = await sendMessage(backgroundConv.id, 'prepare swipe choices');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === backgroundSend.assistantMessageId,
    'foreground swipe reply finished',
  );
  await putSettings({ backgroundSwipeGeneration: true });
  const preparedTree = await ws.waitFor(
    (e) =>
      e.t === 'tree' &&
      e.conversationId === backgroundConv.id &&
      e.activeLeafId === backgroundSend.assistantMessageId &&
      e.messages.some(
        (message) =>
          message.parentId === backgroundSend.userMessageId &&
          message.id !== backgroundSend.assistantMessageId &&
          message.status === 'streaming',
      ),
    'one inactive swipe starts in the background',
  );
  if (preparedTree.t !== 'tree') throw new Error('unreachable');
  const prepared = preparedTree.messages.find(
    (message) =>
      message.parentId === backgroundSend.userMessageId &&
      message.id !== backgroundSend.assistantMessageId,
  )!;
  assert(
    preparedTree.activeLeafId === backgroundSend.assistantMessageId,
    'API-only setting enable starts preparation without changing the visible reply',
  );
  await expectStatus('POST', `/api/generations/${prepared.id}/stop`, undefined, 409);
  await req('POST', `/api/messages/${prepared.id}/activate`, {
    expectedActiveLeafId: backgroundSend.assistantMessageId,
  });
  await expectStatus(
    'POST',
    `/api/messages/${prepared.id}/activate`,
    { expectedActiveLeafId: backgroundSend.assistantMessageId },
    409,
  );
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === prepared.id,
    'activated background swipe finished',
  );
  const nextPreparedTree = await ws.waitFor(
    (e) =>
      e.t === 'tree' &&
      e.conversationId === backgroundConv.id &&
      e.activeLeafId === prepared.id &&
      e.messages.filter((message) => message.parentId === backgroundSend.userMessageId).length ===
        3,
    'activating the prepared swipe starts exactly one successor',
  );
  if (nextPreparedTree.t !== 'tree') throw new Error('unreachable');
  const thirdSwipe = nextPreparedTree.messages.find(
    (message) =>
      message.parentId === backgroundSend.userMessageId &&
      message.id !== backgroundSend.assistantMessageId &&
      message.id !== prepared.id,
  )!;
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === thirdSwipe.id,
    'successor background swipe finished',
  );
  const backgroundSnap = await tree(backgroundConv.id);
  assert(
    backgroundSnap.activeLeafId === prepared.id &&
      backgroundSnap.messages.filter((message) => message.parentId === backgroundSend.userMessageId)
        .length === 3,
    'only one unread swipe is prepared ahead of the reply being read',
  );

  const beforeProtectedResume = backgroundSnap.messages.find(
    (message) => message.id === prepared.id,
  )!.content.length;
  await req('POST', `/api/messages/${prepared.id}/continue`, {
    expectedActiveLeafId: prepared.id,
  });
  await expectStatus(
    'PATCH',
    `/api/conversations/${backgroundConv.id}`,
    { speakerName: 'Rejected while foreground streams' },
    409,
  );
  assert(
    (await tree(backgroundConv.id)).messages.some((message) => message.id === thirdSwipe.id),
    'rejected context edits do not delete completed speculative swipes',
  );
  await ws.waitFor(
    (e) =>
      e.t === 'final' &&
      e.message.id === prepared.id &&
      e.message.content.length > beforeProtectedResume,
    'protected foreground resume finishes',
  );

  console.log('== in-place history edits invalidate completed background swipes ==');
  await req('PATCH', `/api/messages/${backgroundSend.userMessageId}`, {
    content: 'edited swipe context',
    expectedActiveLeafId: prepared.id,
  });
  const editedTree = await ws.waitFor(
    (e) =>
      e.t === 'tree' &&
      e.conversationId === backgroundConv.id &&
      !e.messages.some((message) => message.id === thirdSwipe.id) &&
      e.messages.some(
        (message) =>
          message.parentId === backgroundSend.userMessageId &&
          message.id > thirdSwipe.id &&
          message.generationKind === 'speculative',
      ),
    'history edit refills the speculative swipe',
  );
  if (editedTree.t !== 'tree') throw new Error('unreachable');
  assert(
    !editedTree.messages.some((message) => message.id === thirdSwipe.id),
    'completed speculative reply is removed after an ancestor edit',
  );
  const editedSwipe = editedTree.messages.find(
    (message) =>
      message.parentId === backgroundSend.userMessageId &&
      message.id > thirdSwipe.id &&
      message.generationKind === 'speculative',
  )!;
  const editedFinal = await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === editedSwipe.id,
    'fresh swipe after history edit',
  );
  assert(
    editedFinal.t === 'final' && editedFinal.message.content.includes('edited swipe context'),
    'replacement swipe is generated from the edited history',
  );
  await req('PATCH', `/api/conversations/${backgroundConv.id}`, { speakerName: 'Changed' });
  const invalidatedTree = await ws.waitFor(
    (e) =>
      e.t === 'tree' &&
      e.conversationId === backgroundConv.id &&
      !e.messages.some((message) => message.id === editedSwipe.id) &&
      e.messages.some(
        (message) => message.id > editedSwipe.id && message.generationKind === 'speculative',
      ),
    'conversation context change refills the speculative swipe',
  );
  if (invalidatedTree.t !== 'tree') throw new Error('unreachable');
  assert(
    !invalidatedTree.messages.some((message) => message.id === editedSwipe.id) &&
      invalidatedTree.messages.some(
        (message) => message.id > editedSwipe.id && message.generationKind === 'speculative',
      ),
    'context changes replace stale speculation and preserve one-ahead generation',
  );
  await putSettings({ backgroundSwipeGeneration: false });

  console.log('== failed background generations keep retrying ==');
  const retryConv = await req<{ id: number }>('POST', '/api/conversations', {});
  ws.sub(retryConv.id);
  await ws.waitFor(
    (e) => e.t === 'tree' && e.conversationId === retryConv.id,
    'retry conversation tree',
  );
  const retrySend = await sendMessage(retryConv.id, 'retry background preparation');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === retrySend.assistantMessageId,
    'retry conversation foreground reply',
  );
  await failNextMockRequests(2);
  await putSettings({ backgroundSwipeGeneration: true });
  const retriedFinal = await ws.waitFor(
    (e) =>
      e.t === 'final' &&
      e.message.parentId === retrySend.userMessageId &&
      e.message.id !== retrySend.assistantMessageId &&
      e.message.status === 'done',
    'background preparation succeeds after two failures',
    30_000,
  );
  assert(
    retriedFinal.t === 'final' && retriedFinal.message.generationKind === 'speculative',
    'background refill retries beyond the old one-retry limit',
  );
  await putSettings({ backgroundSwipeGeneration: false });

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
