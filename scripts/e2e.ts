// End-to-end test suite. DESTRUCTIVE: it mutates settings and creates/deletes
// data on the target server — NEVER point it at a live instance. There are
// deliberately no default targets; run it fully isolated (see CLAUDE.md):
//
//   docker compose -p minitavern-e2e -f docker-compose.dev.yml run --rm --no-deps \
//     -e DATA_DIR=/tmp/e2e-data -e E2E_BASE=http://127.0.0.1:15487 -e E2E_MOCK=http://127.0.0.1:19800/v1 \
//     server sh -c 'PORT=15487 node server/src/index.ts & PORT=19800 node scripts/mock-openai.ts & \
//       sleep 2; node scripts/e2e.ts'
import { deflateSync } from 'node:zlib';
import type { Message, ServerEvent, Settings, TreeSnapshot } from '@minitavern/shared';
import { chunk } from './pngChunk.ts';

if (!process.env.E2E_BASE || !process.env.E2E_MOCK) {
  console.error(
    'E2E_BASE and E2E_MOCK must be set explicitly — this suite mutates settings and data\n' +
      'on the target server. Run it against an isolated throwaway instance only.',
  );
  process.exit(1);
}
const BASE = process.env.E2E_BASE;
const MOCK_URL = process.env.E2E_MOCK;
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

function makeCardPng(): Buffer {
  // 1x1 PNG with a tEXt 'chara' chunk carrying a V2 card.
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

const fetchTrace = (id: number) =>
  req<{ messages: { role: string; content: string }[]; namePrefill: string | null }>(
    'GET',
    `/api/conversations/${id}/trace`,
  );

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

async function makeNextMockResponseDieAfterContent(content: string): Promise<void> {
  const res = await fetch(
    `${MOCK_CONTROL}/control/die-after-content?content=${encodeURIComponent(content)}`,
    { method: 'POST' },
  );
  if (!res.ok) throw new Error(`could not configure mid-stream mock death: ${await res.text()}`);
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
  await req('PATCH', `/api/endpoints/${endpoint.id}`, {
    genParams: { reasoningEffort: 'high' },
  });
  await expectStatus(
    'PATCH',
    `/api/endpoints/${endpoint.id}`,
    { genParams: { reasoningEffort: 'extreme' } },
    400,
  );
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
  const withPlugin = await putSettings({
    pluginSettings: { imageGeneration: { describePrompt: 'test prompt' } },
  });
  assert(
    (withPlugin.pluginSettings.imageGeneration as { describePrompt?: string }).describePrompt ===
      'test prompt',
    'plugin settings round-trip through PUT /api/settings',
  );
  await expectStatus(
    'PUT',
    '/api/settings',
    { pluginSettings: 'nope', expectedRevision: withPlugin.revision },
    400,
  );

  console.log('== core chat loop with streaming ==');
  const conv = await req<{ id: number }>('POST', '/api/conversations', { characterId: null });
  const ws = new WsClient();
  await ws.open();
  ws.sendRaw(null);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const settingsAfterBadWs = await req<Settings>('GET', '/api/settings');
  assert(
    typeof settingsAfterBadWs.revision === 'number',
    'malformed WebSocket command does not crash the server',
  );
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
  assert(userMsg1.content === 'Hello world', 'message boundaries are trimmed on write');
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

  // Asserted here (not after the first reply) because the auto-title one-shot
  // fires after that reply and overwrites the mock's last-completion record.
  const effortSeen = (await (await fetch(`${MOCK_CONTROL}/control/last-completion`)).json()) as {
    completion: { reasoningEffort: string | null } | null;
  };
  assert(
    effortSeen.completion?.reasoningEffort === 'high',
    'endpoint reasoningEffort reaches upstream as reasoning_effort',
  );
  snap = await tree(conv.id);
  const assistantSiblings = snap.messages.filter((m) => m.parentId === userMsg1.id);
  assert(assistantSiblings.length === 2, 'two assistant siblings after advancing');
  const assistant2 = assistantSiblings.find((m) => m.id !== assistant1.id)!;
  assert(snap.activeLeafId === assistant2.id, 'new sibling is active');

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
  const editPatch = await ws.waitFor(
    (e) =>
      e.t === 'treePatch' &&
      e.messages.some((m) => m.id === assistant1.id && m.content === 'Rewritten reply.'),
    'patch frame for the in-place edit',
  );
  if (editPatch.t !== 'treePatch') throw new Error('unreachable');
  assert(
    editPatch.messages.length === 1 && editPatch.nodes.length === snap.messages.length,
    'tree patches carry full structure but bodies only for changed messages',
  );

  console.log('== regenerate with instruction includes the original reply ==');
  const steered = await req<{ assistantMessageId: number }>(
    'POST',
    `/api/messages/${assistant1.id}/regenerate`,
    await branchBody(conv.id, { instruction: 'Make this much shorter.' }),
  );
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === steered.assistantMessageId,
    'steered regeneration finished',
  );
  const steeredSeen = (await (await fetch(`${MOCK_CONTROL}/control/last-completion`)).json()) as {
    completion: {
      assistantMessages: string[];
      messages: { role: string; content: string }[];
      lastMessageRole: string | null;
      lastMessageContent: string | null;
    } | null;
  };
  assert(
    steeredSeen.completion?.assistantMessages.includes('Rewritten reply.') === true,
    'steered regeneration sends the original assistant reply upstream',
  );
  assert(
    steeredSeen.completion?.lastMessageRole === 'user' &&
      steeredSeen.completion.lastMessageContent?.includes('Make this much shorter.') === true,
    'one-off steer instruction follows the original reply as a user message',
  );
  const steeredAlternating = steeredSeen.completion!.messages.filter(
    (message) => message.role === 'user' || message.role === 'assistant',
  );
  assert(
    steeredAlternating.every(
      (message, index) =>
        message.content.trim().length > 0 &&
        (index === 0 || message.role !== steeredAlternating[index - 1]!.role),
    ),
    'steered text request keeps user/assistant messages non-empty and alternating',
  );
  snap = await tree(conv.id);
  const steeredMessage = snap.messages.find(
    (message) => message.id === steered.assistantMessageId,
  )!;
  assert(
    steeredMessage.parentId === assistant1.parentId,
    'steered result is stored as a sibling, not as a child of the original reply',
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

  console.log('== delete splices the message out of the chain ==');
  snap = await tree(conv.id);
  const before = snap.messages.length;
  await req(
    'DELETE',
    `/api/messages/${send2.assistantMessageId}?expectedActiveLeafId=${snap.activeLeafId}`,
  );
  snap = await tree(conv.id);
  assert(snap.messages.length === before - 1, 'message deleted');
  assert(snap.activeLeafId !== send2.assistantMessageId, 'active leaf repaired');
  // Mid-path delete: the messages below reparent to the deleted one's parent.
  await req(
    'DELETE',
    `/api/messages/${stoppedSend.assistantMessageId}?expectedActiveLeafId=${send2.userMessageId}`,
  );
  snap = await tree(conv.id);
  assert(snap.messages.length === before - 2, 'only the deleted message is removed');
  assert(
    snap.messages.find((m) => m.id === send2.userMessageId)?.parentId ===
      stoppedSend.userMessageId && snap.activeLeafId === send2.userMessageId,
    'descendants reparent upward and the active leaf survives',
  );
  // Deleting a block with swipes: the sibling alternatives (and their
  // subtrees) die too; only the visible chain below the block survives.
  const blockSend = await sendMessage(conv.id, 'block root');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === blockSend.assistantMessageId,
    'block reply finished',
  );
  const blockSwipe = await req<{ assistantMessageId: number | null }>(
    'POST',
    `/api/messages/${blockSend.assistantMessageId}/advance`,
    { expectedActiveLeafId: blockSend.assistantMessageId },
  );
  const swipeId = blockSwipe.assistantMessageId!;
  await ws.waitFor((e) => e.t === 'final' && e.message.id === swipeId, 'block swipe finished');
  const below = await sendMessage(conv.id, 'below the block');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === below.assistantMessageId,
    'below-block reply finished',
  );
  await req('DELETE', `/api/messages/${swipeId}?expectedActiveLeafId=${below.assistantMessageId}`);
  snap = await tree(conv.id);
  assert(
    !snap.messages.some((m) => m.id === swipeId || m.id === blockSend.assistantMessageId),
    'deleting a block removes its sibling swipes too',
  );
  assert(
    snap.messages.find((m) => m.id === below.userMessageId)?.parentId === blockSend.userMessageId &&
      snap.activeLeafId === below.assistantMessageId,
    'the visible chain below the block survives, reparented',
  );
  // Regression: the treePatch after a splice must carry the survivors' new
  // parentId as a structural update (no full bodies are resent for them).
  const splicePatch = await ws.waitFor(
    (e) =>
      e.t === 'treePatch' &&
      e.conversationId === conv.id &&
      e.nodes.some((n) => n.id === below.userMessageId && n.parentId === blockSend.userMessageId) &&
      !e.nodes.some((n) => n.id === swipeId),
    'splice reparenting travels over the WS patch',
  );
  assert(splicePatch.t === 'treePatch', 'splice patch received');

  console.log('== delete one swipe keeps its sibling branch ==');
  const swipeBase = await sendMessage(conv.id, 'swipe deletion root');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === swipeBase.assistantMessageId,
    'swipe-deletion first reply finished',
  );
  const keptDescendant = await sendMessage(conv.id, 'keep this branch');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === keptDescendant.assistantMessageId,
    'kept swipe descendant finished',
  );
  const doomedSwipe = await req<{ assistantMessageId: number | null }>(
    'POST',
    `/api/messages/${swipeBase.assistantMessageId}/advance`,
    await branchBody(conv.id),
  );
  if (doomedSwipe.assistantMessageId == null) throw new Error('expected a sibling swipe');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === doomedSwipe.assistantMessageId,
    'doomed sibling swipe finished',
  );
  const doomedDescendant = await sendMessage(conv.id, 'delete this branch');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === doomedDescendant.assistantMessageId,
    'doomed swipe descendant finished',
  );
  const swipeDelete = await req<{ activeLeafId: number | null }>(
    'DELETE',
    `/api/messages/${doomedSwipe.assistantMessageId}/swipe?expectedActiveLeafId=${doomedDescendant.assistantMessageId}`,
  );
  snap = await tree(conv.id);
  assert(
    !snap.messages.some(
      (message) =>
        message.id === doomedSwipe.assistantMessageId ||
        message.id === doomedDescendant.userMessageId ||
        message.id === doomedDescendant.assistantMessageId,
    ),
    'delete swipe removes the selected alternative and its subtree',
  );
  assert(
    snap.messages.some((message) => message.id === swipeBase.assistantMessageId) &&
      snap.messages.some((message) => message.id === keptDescendant.userMessageId) &&
      snap.messages.some((message) => message.id === keptDescendant.assistantMessageId) &&
      swipeDelete.activeLeafId === keptDescendant.assistantMessageId &&
      snap.activeLeafId === keptDescendant.assistantMessageId,
    'delete swipe preserves and activates the remaining sibling branch',
  );

  console.log('== message move and duplicate ==');
  const mv = await sendMessage(conv.id, 'move me');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === mv.assistantMessageId,
    'move-me reply finished',
  );
  const mvParent = (await tree(conv.id)).messages.find((m) => m.id === mv.userMessageId)!.parentId;
  await req('POST', `/api/messages/${mv.assistantMessageId}/move`, {
    direction: 'up',
    expectedActiveLeafId: mv.assistantMessageId,
  });
  snap = await tree(conv.id);
  assert(
    snap.messages.find((m) => m.id === mv.assistantMessageId)?.parentId === mvParent &&
      snap.messages.find((m) => m.id === mv.userMessageId)?.parentId === mv.assistantMessageId &&
      snap.activeLeafId === mv.userMessageId,
    'move up rotates the block above its parent',
  );
  await req('POST', `/api/messages/${mv.userMessageId}/move`, {
    direction: 'up',
    expectedActiveLeafId: mv.userMessageId,
  });
  snap = await tree(conv.id);
  assert(
    snap.messages.find((m) => m.id === mv.userMessageId)?.parentId === mvParent &&
      snap.messages.find((m) => m.id === mv.assistantMessageId)?.parentId === mv.userMessageId &&
      snap.activeLeafId === mv.assistantMessageId,
    'moving back restores the original order',
  );
  const dup = await req<{ messageId: number; activeLeafId: number }>(
    'POST',
    `/api/messages/${mv.assistantMessageId}/duplicate`,
    { expectedActiveLeafId: mv.assistantMessageId },
  );
  snap = await tree(conv.id);
  const dupMsg = snap.messages.find((m) => m.id === dup.messageId);
  assert(
    dupMsg?.parentId === mv.userMessageId &&
      dupMsg.content === snap.messages.find((m) => m.id === mv.assistantMessageId)!.content &&
      snap.activeLeafId === dup.messageId,
    'duplicate creates an activated sibling copy',
  );
  await expectStatus(
    'POST',
    `/api/messages/${dup.messageId}/move`,
    { direction: 'down', expectedActiveLeafId: dup.messageId },
    400,
  );

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
  const settingsAfterBomb = await req<Settings>('GET', '/api/settings');
  assert(
    typeof settingsAfterBomb.revision === 'number',
    'server remains responsive after compressed metadata rejection',
  );
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

  console.log('== avatars accept PNG only ==');
  // Magic bytes decide, not the content-type: a renamed JPEG stored as .png
  // would break PNG card export later.
  const jpegBytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60)]);
  const webpBytes = Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBP', 'latin1'), Buffer.alloc(48)]);
  const putAvatar = (path: string, body: Uint8Array) =>
    fetch(`${BASE}${path}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body,
    });
  const jpegCharRes = await putAvatar(`/api/characters/${character.id}/avatar`, jpegBytes);
  assert(jpegCharRes.status === 415, 'character avatar upload rejects JPEG magic bytes');
  const webpCharRes = await putAvatar(`/api/characters/${character.id}/avatar`, webpBytes);
  assert(webpCharRes.status === 415, 'character avatar upload rejects WebP magic bytes');
  const pngCharRes = await putAvatar(
    `/api/characters/${character.id}/avatar`,
    new Uint8Array(makeCardPng()),
  );
  assert(pngCharRes.ok, 'character avatar upload accepts a valid PNG');
  const pngChar = (await pngCharRes.json()) as { avatar: string | null };
  assert(pngChar.avatar?.includes('.png') === true, 'stored avatar is served as a .png file');
  const jpegPersonaRes = await putAvatar(`/api/personas/${persona.id}/avatar`, jpegBytes);
  assert(jpegPersonaRes.status === 415, 'persona avatar upload rejects JPEG magic bytes');

  console.log('== avatar generation (prompt stream + comfy render) ==');
  const AVATAR_WORKFLOW =
    '{"3":{"class_type":"KSampler","inputs":{"seed":{{seed}}}},"6":{"inputs":{"text":"{{prompt}}"}}}';
  // The client builds the request from the plugin settings — do the same.
  await putSettings({
    pluginSettings: {
      imageGeneration: {
        avatarPrompt: 'Portrait of {{char}}. Details: {{description}}. Setting: {{scenario}}.',
        comfyUrl: MOCK_CONTROL,
        workflows: [{ name: 'Avatar', json: AVATAR_WORKFLOW }],
        activeWorkflow: 'Avatar',
      },
    },
  });
  const imageGenCfg = ((await req<Settings>('GET', '/api/settings')).pluginSettings
    .imageGeneration as {
    avatarPrompt: string;
    comfyUrl: string;
    workflows: { name: string; json: string }[];
    activeWorkflow: string;
  })!;
  const avatarImage = {
    workflow: imageGenCfg.workflows.find((w) => w.name === imageGenCfg.activeWorkflow)!.json,
    comfyUrl: imageGenCfg.comfyUrl,
  };
  const avatarChar = await req<{ id: number }>('POST', '/api/characters', {
    name: 'Avatar Hero',
    personality: 'a brave knight with silver hair',
    scenario: 'a mountain keep',
  });

  /** Reads an avatar prompt SSE stream, returning the assembled text. */
  const streamAvatarPrompt = async (path: string, prompt: string): Promise<string> => {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    assert(
      res.ok && res.headers.get('content-type')?.includes('text/event-stream') === true,
      `prompt stream at ${path} responds with SSE`,
    );
    const body = await res.text();
    let text = '';
    let sawDone = false;
    let sawError = false;
    for (const line of body.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = JSON.parse(line.slice(5)) as { d?: string; error?: string; done?: boolean };
      if (payload.error !== undefined) sawError = true;
      if (payload.d) text += payload.d;
      if (payload.done) sawDone = true;
    }
    assert(!sawError, `prompt stream at ${path} carries no error event`);
    assert(sawDone, `prompt stream at ${path} terminates with a done event`);
    return text;
  };

  // A second stream for the same entity 409s while the first is in flight.
  const firstStream = streamAvatarPrompt(
    `/api/characters/${avatarChar.id}/avatar/prompt`,
    imageGenCfg.avatarPrompt,
  );
  // Let the first request reach the server and claim the per-entity slot.
  await new Promise((resolve) => setTimeout(resolve, 100));
  await expectStatus(
    'POST',
    `/api/characters/${avatarChar.id}/avatar/prompt`,
    { prompt: imageGenCfg.avatarPrompt },
    409,
  );
  const avatarPrompt = await firstStream;
  assert(avatarPrompt.includes('Avatar Hero'), 'prompt stream relays the LLM completion text');

  // The streamed request hit the mock with macros expanded from the character.
  const { completion: avatarCompletion } = (await (
    await fetch(`${MOCK_CONTROL}/control/last-completion`)
  ).json()) as { completion: { system: string | null; user: string | null } };
  assert(
    avatarCompletion.system ===
      'Portrait of Avatar Hero. Details: a brave knight with silver hair. Setting: a mountain keep.',
    'avatar prompt macros expand from the character fields',
  );
  assert(
    avatarCompletion.user?.includes('Avatar Hero') === true &&
      avatarCompletion.user.includes('a brave knight with silver hair'),
    'the model is given the serialized character fields',
  );

  // Render: the (possibly edited) prompt goes in, image bytes come out.
  const renderRes = await fetch(`${BASE}/api/avatar/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: avatarPrompt, image: avatarImage }),
  });
  assert(
    renderRes.ok && renderRes.headers.get('content-type') === 'image/png',
    'avatar render returns PNG bytes',
  );
  const renderedPng = Buffer.from(await renderRes.arrayBuffer());
  assert(renderedPng[0] === 0x89 && renderedPng[1] === 0x50, 'avatar render is a real PNG');
  const { workflow: avatarWorkflow } = (await (
    await fetch(`${MOCK_CONTROL}/control/last-workflow`)
  ).json()) as { workflow: { 6: { inputs: { text: string } } } };
  assert(
    avatarWorkflow[6].inputs.text.includes(avatarPrompt.slice(0, 30)),
    'the prompt lands in the workflow {{prompt}} slot',
  );

  // Saving the rendered bytes goes through the normal avatar upload route.
  const genCharRes = await putAvatar(`/api/characters/${avatarChar.id}/avatar`, renderedPng);
  assert(genCharRes.ok, 'rendered avatar saves through the avatar upload route');

  // A jobId gets live sampler progress as renderProgress broadcasts.
  const avatarWs = new WsClient();
  await avatarWs.open();
  const avatarJobId = 'e2e-avatar-job';
  const progressSeen = avatarWs.waitFor(
    (ev) => ev.t === 'renderProgress' && ev.jobId === avatarJobId && ev.max > 0,
    'avatar render progress event',
  );
  const progressRenderRes = await fetch(`${BASE}/api/avatar/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'progress check', image: avatarImage, jobId: avatarJobId }),
  });
  assert(progressRenderRes.ok, 'avatar render with jobId succeeds');
  await progressSeen;
  assert(true, 'jobId render broadcasts renderProgress events');
  avatarWs.close();

  // Persona variant: {{user}}/{{description}} from the persona row.
  await streamAvatarPrompt(
    `/api/personas/${persona.id}/avatar/prompt`,
    'Portrait of {{user}}: {{description}}',
  );
  const { completion: personaCompletion } = (await (
    await fetch(`${MOCK_CONTROL}/control/last-completion`)
  ).json()) as { completion: { system: string | null } };
  assert(
    personaCompletion.system === 'Portrait of Aiki: A performance-obsessed developer.',
    'persona avatar prompt macros expand from the persona fields',
  );

  await expectStatus(
    'POST',
    `/api/characters/${avatarChar.id}/avatar/prompt`,
    { prompt: '  ' },
    400,
  );
  await expectStatus('POST', '/api/characters/999999999/avatar/prompt', { prompt: 'x' }, 404);
  await expectStatus('POST', '/api/personas/999999999/avatar/prompt', { prompt: 'x' }, 404);
  await expectStatus('POST', '/api/avatar/render', { prompt: '  ', image: avatarImage }, 400);
  await expectStatus(
    'POST',
    '/api/avatar/render',
    { prompt: 'x', image: { workflow: '', comfyUrl: MOCK_CONTROL } },
    400,
  );
  await expectStatus(
    'POST',
    '/api/avatar/render',
    { prompt: 'x', image: { workflow: '{not json', comfyUrl: MOCK_CONTROL } },
    400,
  );

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

  const trace = await fetchTrace(conv2.id);
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
  const prefixedTrace = await fetchTrace(conv2.id);
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

  console.log('== endpoint can disable assistant prefills ==');
  await req('PATCH', `/api/endpoints/${endpoint.id}`, { prefillMode: 'disabled' });
  assert(
    (await fetchTrace(conv2.id)).namePrefill === null,
    'prompt trace omits the disabled endpoint prefill',
  );
  const noPrefillSend = await sendMessage(conv2.id, 'no prefill, please');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === noPrefillSend.assistantMessageId,
    'generation with prefills disabled finished',
  );
  let noPrefillCompletion = (await (
    await fetch(`${MOCK_CONTROL}/control/last-completion`)
  ).json()) as {
    completion: { lastMessageRole: string | null; continueFinalMessage: boolean } | null;
  };
  assert(
    noPrefillCompletion.completion?.lastMessageRole === 'user' &&
      noPrefillCompletion.completion.continueFinalMessage === false,
    'disabled endpoint omits speaker-name prefill and native continuation flag',
  );

  const noPrefillBeforeResume = (await tree(conv2.id)).messages.find(
    (m) => m.id === noPrefillSend.assistantMessageId,
  )!.content.length;
  await req(
    'POST',
    `/api/messages/${noPrefillSend.assistantMessageId}/continue`,
    await branchBody(conv2.id),
  );
  await ws.waitFor(
    (e) =>
      e.t === 'final' &&
      e.message.id === noPrefillSend.assistantMessageId &&
      e.message.content.length > noPrefillBeforeResume,
    'resume with prefills disabled finished',
  );
  noPrefillCompletion = (await (
    await fetch(`${MOCK_CONTROL}/control/last-completion`)
  ).json()) as typeof noPrefillCompletion;
  assert(
    noPrefillCompletion.completion?.lastMessageRole === 'user' &&
      noPrefillCompletion.completion.continueFinalMessage === false,
    'disabled endpoint also omits partial-content prefill on resume',
  );
  await req('PATCH', `/api/endpoints/${endpoint.id}`, { prefillMode: 'none' });

  const clearedTemplates = await putSettings({ defaultTemplateId: null });
  assert(
    clearedTemplates.defaultTemplateId === null,
    'defaultTemplateId can be cleared to the built-in default',
  );
  await putSettings({ defaultTemplateId: prevSettings.defaultTemplateId });

  console.log('== character inline custom template ==');
  const inlineChar = await req<{ id: number }>('POST', '/api/characters', {
    name: 'Inline Hero',
    customTemplate: {
      content: '{{system}} INLINE {{char}} + {{user}}',
      userPrologue: 'Inline prologue for {{char}}.',
      prefixNames: true,
      usesPersonas: false,
    },
  });
  const inlineConv = await req<{ id: number }>('POST', '/api/conversations', {
    characterId: inlineChar.id,
  });
  const inlineTrace = await fetchTrace(inlineConv.id);
  assert(
    inlineTrace.messages.some(
      (m) => m.role === 'system' && m.content.endsWith('INLINE Inline Hero + User'),
    ),
    'inline template renders its content; usesPersonas=false ignores the persona',
  );
  assert(
    inlineTrace.messages.some(
      (m) => m.role === 'user' && m.content === 'Inline prologue for Inline Hero.',
    ),
    'inline template emits its prologue',
  );
  assert(inlineTrace.namePrefill === 'Inline Hero:', 'inline template enables name prefixing');

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

  console.log('== per-conversation endpoint override ==');
  const smallEndpoint = await req<{ id: number }>('POST', '/api/endpoints', {
    name: 'mock-small',
    baseUrl: MOCK_URL,
    model: 'mock-small',
  });
  const overridden = await req<{ endpointId: number | null }>(
    'PATCH',
    `/api/conversations/${conv2.id}`,
    { endpointId: smallEndpoint.id },
  );
  assert(overridden.endpointId === smallEndpoint.id, 'endpoint override persisted');
  const overrideSend = await sendMessage(conv2.id, 'which model?');
  const overrideFinal = await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === overrideSend.assistantMessageId,
    'override generation finished',
  );
  assert(
    overrideFinal.t === 'final' && overrideFinal.message.model === 'mock-small',
    'generation uses the conversation endpoint override',
  );
  await req('PATCH', `/api/conversations/${conv2.id}`, { endpointId: null });
  const revertSend = await sendMessage(conv2.id, 'back to global');
  const revertFinal = await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === revertSend.assistantMessageId,
    'reverted generation finished',
  );
  assert(
    revertFinal.t === 'final' && revertFinal.message.model === 'mock-large',
    'clearing the override falls back to the global endpoint',
  );

  console.log('== plugin tool generation (foreground, role=tool) ==');
  const toolSnap = await tree(conv2.id);
  const toolRes = await req<{ toolMessageId: number; activeLeafId: number }>(
    'POST',
    `/api/conversations/${conv2.id}/tool`,
    {
      prompt: 'Describe {{char}} for {{user}}.',
      label: 'Image prompt',
      expectedActiveLeafId: toolSnap.activeLeafId,
    },
  );
  // Foreground semantics: a concurrent send is rejected while the tool streams.
  await expectStatus(
    'POST',
    `/api/conversations/${conv2.id}/messages`,
    { content: 'busy', expectedActiveLeafId: toolRes.toolMessageId },
    409,
  );
  const toolFinal = await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === toolRes.toolMessageId,
    'tool generation finished',
  );
  assert(
    toolFinal.t === 'final' &&
      toolFinal.message.role === 'tool' &&
      toolFinal.message.status === 'done',
    'tool output streams into a role=tool message',
  );
  assert(
    toolFinal.message.content.includes('Describe Assistant for Aiki.'),
    'tool prompt gets {{char}}/{{user}} expanded and the chat context',
  );
  const toolTrace = await fetchTrace(conv2.id);
  assert(
    toolTrace.messages.every(
      (m) => m.role !== 'tool' && !m.content.includes('Describe Assistant for Aiki.'),
    ),
    'tool messages are excluded from prompt history',
  );

  console.log('== comfy image rendering ==');
  const comfyDeleteCount = async () =>
    (
      (await (await fetch(`${MOCK_CONTROL}/control/comfy-deleted`)).json()) as {
        deleted: { filename: string; type: string }[];
      }
    ).deleted;
  const deletesBeforeRender = (await comfyDeleteCount()).length;
  const COMFY_WORKFLOW =
    '{"3":{"class_type":"KSampler","inputs":{"seed":{{seed}}}},"6":{"inputs":{"text":"{{prompt}}"}}}';
  const imgSnap = await tree(conv2.id);
  const imgRes = await req<{ toolMessageId: number }>(
    'POST',
    `/api/conversations/${conv2.id}/tool`,
    {
      prompt: 'Depict this scene.',
      label: 'Image prompt',
      expectedActiveLeafId: imgSnap.activeLeafId,
      image: { workflow: COMFY_WORKFLOW, comfyUrl: MOCK_CONTROL },
    },
  );
  const pendingSnap = await tree(conv2.id);
  assert(
    pendingSnap.messages.find((m) => m.id === imgRes.toolMessageId)?.imagePending === true,
    'image render is flagged pending while the tool text streams',
  );
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === imgRes.toolMessageId,
    'image tool text finished',
  );
  await ws.waitFor(
    (e) => e.t === 'imageProgress' && e.mid === imgRes.toolMessageId,
    'image render progress relayed to subscribers',
    15_000,
  );
  let imageUrl: string | null = null;
  for (let i = 0; i < 60 && !imageUrl; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const snap = await tree(conv2.id);
    const message = snap.messages.find((m) => m.id === imgRes.toolMessageId);
    if (message && !message.imagePending && message.images.length > 0) {
      imageUrl = message.images[0]!;
    }
  }
  assert(imageUrl?.startsWith('/images/'), 'rendered image attached to the tool message');
  const served = await fetch(`${BASE}${imageUrl}`);
  assert(
    served.ok &&
      served.headers.get('content-type') === 'image/png' &&
      (await served.arrayBuffer()).byteLength > 0,
    'generated image is served from /images/',
  );
  // The download is followed by a best-effort DELETE /view, so ComfyUI doesn't
  // keep a second copy of every image we already own. It is fire-and-forget on
  // the server, hence the poll rather than a straight read.
  let comfyDeletes = await comfyDeleteCount();
  for (let i = 0; i < 40 && comfyDeletes.length === deletesBeforeRender; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    comfyDeletes = await comfyDeleteCount();
  }
  assert(
    comfyDeletes.length === deletesBeforeRender + 1 &&
      comfyDeletes.at(-1)!.filename === 'mock.png' &&
      comfyDeletes.at(-1)!.type === 'output',
    'the downloaded output is deleted from ComfyUI',
  );

  const { workflow: substituted } = (await (
    await fetch(`${MOCK_CONTROL}/control/last-workflow`)
  ).json()) as {
    workflow: { 3: { inputs: { seed: unknown } }; 6: { inputs: { text: string } } };
  };
  assert(typeof substituted[3].inputs.seed === 'number', '{{seed}} substituted as a number');
  assert(
    substituted[6].inputs.text.includes('You said:') && substituted[6].inputs.text.includes('"'),
    '{{prompt}} carries the JSON-escaped description with quotes intact',
  );

  // Image swipes: re-render with the same stored prompt/workflow, fresh seed.
  const firstSeed = substituted[3].inputs.seed;
  await req('POST', `/api/messages/${imgRes.toolMessageId}/render-image`);
  let regenMsg: Message | undefined;
  for (let i = 0; i < 60 && !regenMsg; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const snap = await tree(conv2.id);
    const message = snap.messages.find((m) => m.id === imgRes.toolMessageId);
    if (message && !message.imagePending && message.images.length === 2) regenMsg = message;
  }
  assert(
    regenMsg != null && regenMsg.activeImage === 1,
    'regenerated image is appended and selected',
  );
  assert(regenMsg.images[0] !== regenMsg.images[1], 'each render produces a distinct image file');
  const { workflow: regenWorkflow } = (await (
    await fetch(`${MOCK_CONTROL}/control/last-workflow`)
  ).json()) as { workflow: { 3: { inputs: { seed: unknown } } } };
  assert(regenWorkflow[3].inputs.seed !== firstSeed, 'regeneration uses a fresh seed');
  await req('POST', `/api/messages/${imgRes.toolMessageId}/active-image`, { index: 0 });
  assert(
    (await tree(conv2.id)).messages.find((m) => m.id === imgRes.toolMessageId)?.activeImage === 0,
    'active image selection persists',
  );
  const secondImageUrl = regenMsg.images[1]!;

  console.log('== regenerate image tool with instruction ==');
  const imageRevisionTrace = await fetchTrace(conv2.id);
  const steeredImage = await req<{ assistantMessageId: number }>(
    'POST',
    `/api/messages/${imgRes.toolMessageId}/regenerate`,
    await branchBody(conv2.id, { instruction: 'Make the scene moonlit.' }),
  );
  const steeredImageFinal = await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === steeredImage.assistantMessageId,
    'steered image prompt finished',
  );
  const imageSteerSeen = (await (
    await fetch(`${MOCK_CONTROL}/control/last-completion`)
  ).json()) as {
    completion: {
      messages: { role: string; content: string }[];
      lastMessageRole: string | null;
      lastMessageContent: string | null;
    } | null;
  };
  assert(
    imageSteerSeen.completion?.messages.some((message) =>
      message.content.includes(regenMsg.content),
    ) === true,
    'image steer sends the original generated prompt upstream',
  );
  assert(
    imageSteerSeen.completion?.lastMessageRole === 'user' &&
      imageSteerSeen.completion.lastMessageContent?.includes('[IMAGE PROMPT REVISION TASK]') ===
        true &&
      imageSteerSeen.completion.lastMessageContent.includes('reference context only') &&
      imageSteerSeen.completion.lastMessageContent.includes('Do not continue the roleplay') &&
      imageSteerSeen.completion.lastMessageContent.includes('Do not modify anything else.') &&
      imageSteerSeen.completion.lastMessageContent?.includes('<original_image_prompt>') === true &&
      imageSteerSeen.completion.lastMessageContent.includes('<revision_instruction>') &&
      imageSteerSeen.completion.lastMessageContent?.includes('Make the scene moonlit.') === true &&
      imageSteerSeen.completion.lastMessageContent.includes(regenMsg.content),
    'image steer clearly separates the original prompt from the constrained instruction',
  );
  assert(
    JSON.stringify(
      imageSteerSeen.completion?.messages.slice(0, imageRevisionTrace.messages.length),
    ) === JSON.stringify(imageRevisionTrace.messages),
    'image steer preserves the exact roleplay-history prefix for context and caching',
  );
  const imageSteerAlternating = imageSteerSeen.completion!.messages.filter(
    (message) => message.role === 'user' || message.role === 'assistant',
  );
  assert(
    imageSteerAlternating.every(
      (message, index) =>
        message.content.trim().length > 0 &&
        (index === 0 || message.role !== imageSteerAlternating[index - 1]!.role),
    ),
    'steered image request keeps contextual user/assistant history alternating',
  );
  assert(
    steeredImageFinal.t === 'final' &&
      steeredImageFinal.message.role === 'tool' &&
      steeredImageFinal.message.parentId === imgRes.toolMessageId &&
      steeredImageFinal.message.hasImageRender,
    'steered image prompt is appended after the source with its render configuration retained',
  );
  let steeredImageRendered: Message | undefined;
  for (let i = 0; i < 60 && !steeredImageRendered; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const message = (await tree(conv2.id)).messages.find(
      (candidate) => candidate.id === steeredImage.assistantMessageId,
    );
    if (message && !message.imagePending && message.images.length === 1) {
      steeredImageRendered = message;
    }
  }
  assert(steeredImageRendered != null, 'steered image prompt automatically renders a fresh image');
  // Remove this test revision so the following chain/deletion checks continue
  // to exercise their original shape from the source image message.
  await req(
    'DELETE',
    `/api/messages/${steeredImage.assistantMessageId}?expectedActiveLeafId=${steeredImage.assistantMessageId}`,
  );
  assert(
    (await tree(conv2.id)).activeLeafId === imgRes.toolMessageId,
    'removing the revised image returns to the source image message',
  );

  // Consecutive tool runs chain parent→child; deleting a tool message must
  // splice it out (descendants survive) and still delete its image from disk.
  const chained = await req<{ toolMessageId: number }>(
    'POST',
    `/api/conversations/${conv2.id}/tool`,
    {
      prompt: 'Another one.',
      label: 'Image prompt',
      expectedActiveLeafId: imgRes.toolMessageId,
    },
  );
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === chained.toolMessageId,
    'chained tool generation finished',
  );
  const chainSnap = await tree(conv2.id);
  assert(
    chainSnap.messages.find((m) => m.id === chained.toolMessageId)?.parentId ===
      imgRes.toolMessageId,
    'consecutive tool messages chain parent→child',
  );

  console.log('== regenerate image tool in the middle of an existing chain ==');
  const insertedRevision = await req<{ assistantMessageId: number }>(
    'POST',
    `/api/messages/${imgRes.toolMessageId}/regenerate`,
    await branchBody(conv2.id, { instruction: 'Make the scene warmer.' }),
  );
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === insertedRevision.assistantMessageId,
    'inserted image revision prompt finished',
  );
  const insertedSnap = await tree(conv2.id);
  const sourceAfterInsert = insertedSnap.messages.find((m) => m.id === imgRes.toolMessageId)!;
  const insertedMessage = insertedSnap.messages.find(
    (m) => m.id === insertedRevision.assistantMessageId,
  )!;
  const chainedAfterInsert = insertedSnap.messages.find((m) => m.id === chained.toolMessageId)!;
  assert(
    insertedMessage.parentId === imgRes.toolMessageId &&
      chainedAfterInsert.parentId === insertedMessage.id &&
      sourceAfterInsert.activeChildId === insertedMessage.id &&
      insertedMessage.activeChildId === chained.toolMessageId &&
      insertedSnap.activeLeafId === chained.toolMessageId,
    'image revision splices into the chain and preserves the active continuation',
  );
  let insertedRendered: Message | undefined;
  for (let i = 0; i < 60 && !insertedRendered; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const message = (await tree(conv2.id)).messages.find(
      (candidate) => candidate.id === insertedRevision.assistantMessageId,
    );
    if (message && !message.imagePending && message.images.length === 1) {
      insertedRendered = message;
    }
  }
  assert(insertedRendered != null, 'inserted image revision renders normally');
  await req(
    'DELETE',
    `/api/messages/${insertedRevision.assistantMessageId}?expectedActiveLeafId=${chained.toolMessageId}`,
  );
  const restoredChain = await tree(conv2.id);
  assert(
    restoredChain.messages.find((m) => m.id === chained.toolMessageId)?.parentId ===
      imgRes.toolMessageId && restoredChain.activeLeafId === chained.toolMessageId,
    'deleting the inserted revision restores the original chain',
  );

  const imgParent = chainSnap.messages.find((m) => m.id === imgRes.toolMessageId)!.parentId;
  await req(
    'DELETE',
    `/api/messages/${imgRes.toolMessageId}?expectedActiveLeafId=${chained.toolMessageId}`,
  );
  const splicedSnap = await tree(conv2.id);
  const survivor = splicedSnap.messages.find((m) => m.id === chained.toolMessageId);
  assert(
    survivor?.parentId === imgParent && splicedSnap.activeLeafId === chained.toolMessageId,
    'deleting a tool message splices it out, keeping its descendants',
  );
  const afterDelete = await fetch(`${BASE}${imageUrl}`);
  const afterDelete2 = await fetch(`${BASE}${secondImageUrl}`);
  assert(
    afterDelete.status === 404 && afterDelete2.status === 404,
    'deleting the tool message deletes all its image files from disk',
  );

  console.log('== comfy render failures surface and are retryable ==');
  const waitForImageState = async (
    mid: number,
    pred: (m: Message) => boolean,
    label: string,
  ): Promise<Message> => {
    for (let i = 0; i < 60; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const message = (await tree(conv2.id)).messages.find((m) => m.id === mid);
      if (message && pred(message)) return message;
    }
    throw new Error(`timeout waiting for: ${label}`);
  };

  await fetch(`${MOCK_CONTROL}/control/comfy-fail-next?stage=prompt&count=1`, { method: 'POST' });
  const failSnap = await tree(conv2.id);
  const failRes = await req<{ toolMessageId: number }>(
    'POST',
    `/api/conversations/${conv2.id}/tool`,
    {
      prompt: 'Depict a failure.',
      label: 'Image prompt',
      expectedActiveLeafId: failSnap.activeLeafId,
      image: { workflow: COMFY_WORKFLOW, comfyUrl: MOCK_CONTROL },
    },
  );
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === failRes.toolMessageId,
    'failing image tool text finished',
  );
  // The failure must be pushed to subscribers (patch with the updated body),
  // not just persisted for the next refetch.
  const failPatch = await ws.waitFor(
    (e) =>
      e.t === 'treePatch' &&
      e.messages.some((m) => m.id === failRes.toolMessageId && m.genMeta?.imageError != null),
    'render failure broadcast to subscribers',
  );
  const failedMsg =
    failPatch.t === 'treePatch'
      ? failPatch.messages.find((m) => m.id === failRes.toolMessageId)
      : undefined;
  assert(
    failedMsg?.imagePending === false &&
      failedMsg.images.length === 0 &&
      failedMsg.status === 'done' &&
      failedMsg.genMeta?.imageError?.includes('rejected the workflow (500)') === true,
    'a rejected submission clears imagePending and surfaces genMeta.imageError',
  );

  // Retry (the client's Retry button) re-renders from the stored config.
  await req('POST', `/api/messages/${failRes.toolMessageId}/render-image`);
  const retried = await waitForImageState(
    failRes.toolMessageId,
    (m) => !m.imagePending && m.images.length === 1,
    'retry render finished',
  );
  assert(retried.genMeta?.imageError == null, 'a successful retry clears the stored imageError');

  await fetch(`${MOCK_CONTROL}/control/comfy-fail-next?stage=render&count=1`, { method: 'POST' });
  await req('POST', `/api/messages/${failRes.toolMessageId}/render-image`);
  const execFailed = await waitForImageState(
    failRes.toolMessageId,
    (m) => !m.imagePending && m.genMeta?.imageError != null,
    'execution failure surfaced',
  );
  assert(
    execFailed.genMeta?.imageError?.includes('KSampler [3] RuntimeError: mock render explosion') ===
      true,
    'execution failures relay the ComfyUI node traceback',
  );
  assert(execFailed.images.length === 1, 'a failed re-render keeps previously rendered images');

  console.log('== tool message guards ==');
  await expectStatus(
    'POST',
    `/api/messages/${failRes.toolMessageId}/advance`,
    { expectedActiveLeafId: failRes.toolMessageId },
    400,
  );
  await expectStatus(
    'POST',
    `/api/messages/${failRes.toolMessageId}/continue`,
    { expectedActiveLeafId: failRes.toolMessageId },
    400,
  );

  // Stopping the text generation must clear its queued render — finalize on a
  // non-done ending would otherwise leave imagePending stuck forever.
  const stopSnap = await tree(conv2.id);
  const stopRes = await req<{ toolMessageId: number }>(
    'POST',
    `/api/conversations/${conv2.id}/tool`,
    {
      prompt: 'Will be stopped.',
      label: 'Image prompt',
      expectedActiveLeafId: stopSnap.activeLeafId,
      image: { workflow: COMFY_WORKFLOW, comfyUrl: MOCK_CONTROL },
    },
  );
  await req('POST', `/api/generations/${stopRes.toolMessageId}/stop`);
  const stoppedMsg = (await tree(conv2.id)).messages.find((m) => m.id === stopRes.toolMessageId);
  assert(
    stoppedMsg?.status === 'stopped' &&
      stoppedMsg.imagePending === false &&
      stoppedMsg.images.length === 0,
    'stopping a tool generation clears its queued image render',
  );

  // render-image is role-agnostic (fallback config stored on first use), and
  // resume is refused while the render is pending — finalize on the resumed
  // generation's non-done endings would disown it.
  const renderSend = await sendMessage(conv2.id, 'draw the last reply');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === renderSend.assistantMessageId,
    'assistant reply to render finished',
  );
  await req('POST', `/api/messages/${renderSend.assistantMessageId}/render-image`, {
    workflow: COMFY_WORKFLOW,
    comfyUrl: MOCK_CONTROL,
  });
  await expectStatus(
    'POST',
    `/api/messages/${renderSend.assistantMessageId}/continue`,
    { expectedActiveLeafId: renderSend.assistantMessageId },
    409,
  );
  const assistantRendered = await waitForImageState(
    renderSend.assistantMessageId,
    (m) => !m.imagePending && m.images.length === 1,
    'assistant-message render finished',
  );
  assert(assistantRendered.hasImageRender, 'fallback render config is stored for future swipes');

  console.log('== transient upstream failures auto-resume ==');
  await failNextMockRequests(1);
  const resilientSend = await sendMessage(conv2.id, 'survive a blip');
  const resilientFinal = await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === resilientSend.assistantMessageId,
    'generation survives one upstream 503',
    20_000,
  );
  assert(
    resilientFinal.t === 'final' &&
      resilientFinal.message.status === 'done' &&
      resilientFinal.message.content.length > 0,
    'foreground generation retries transparently after a transient failure',
  );
  await failNextMockRequests(3);
  const doomedSend = await sendMessage(conv2.id, 'exhaust the retries');
  const doomedFinal = await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === doomedSend.assistantMessageId,
    'generation fails once retries are exhausted',
    30_000,
  );
  assert(
    doomedFinal.t === 'final' &&
      doomedFinal.message.status === 'error' &&
      doomedFinal.message.generationKind === 'normal' &&
      doomedFinal.message.genMeta?.error?.includes('503') === true,
    'exhausted retries surface the upstream error on the message',
  );

  console.log('== held-back name prefix survives a transient retry ==');
  await putSettings({ defaultTemplateId: tpl.id });
  const holdbackConv = await req<{ id: number }>('POST', '/api/conversations', {});
  await req('PATCH', `/api/conversations/${holdbackConv.id}`, { speakerName: 'Hal' });
  ws.sub(holdbackConv.id);
  await ws.waitFor(
    (e) => e.t === 'tree' && e.conversationId === holdbackConv.id,
    'holdback conversation tree',
  );
  // The mock dies after "Ha" — a case-insensitive prefix of the "Hal:" prefill,
  // so the server is still holding it back when the stream cuts out. The retry
  // resumes prefill-style from the flushed holdback and streams normally.
  await makeNextMockResponseDieAfterContent('Ha');
  const holdbackSend = await sendMessage(holdbackConv.id, 'holdback check');
  const holdbackFinal = await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === holdbackSend.assistantMessageId,
    'held-back prefix generation retried to completion',
    20_000,
  );
  assert(
    holdbackFinal.t === 'final' &&
      holdbackFinal.message.status === 'done' &&
      holdbackFinal.message.content.startsWith('HaYou said:'),
    'held-back prefix characters are kept exactly once across the retry',
  );
  await putSettings({ defaultTemplateId: prevSettings.defaultTemplateId });

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
      e.t === 'treePatch' &&
      e.conversationId === backgroundConv.id &&
      e.activeLeafId === backgroundSend.assistantMessageId &&
      e.nodes.some(
        (node) =>
          node.parentId === backgroundSend.userMessageId &&
          node.id !== backgroundSend.assistantMessageId &&
          node.status === 'streaming',
      ),
    'one inactive swipe starts in the background',
  );
  if (preparedTree.t !== 'treePatch') throw new Error('unreachable');
  const prepared = preparedTree.nodes.find(
    (node) =>
      node.parentId === backgroundSend.userMessageId &&
      node.id !== backgroundSend.assistantMessageId,
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
      e.t === 'treePatch' &&
      e.conversationId === backgroundConv.id &&
      e.activeLeafId === prepared.id &&
      e.nodes.filter((node) => node.parentId === backgroundSend.userMessageId).length === 3,
    'activating the prepared swipe starts exactly one successor',
  );
  if (nextPreparedTree.t !== 'treePatch') throw new Error('unreachable');
  const thirdSwipe = nextPreparedTree.nodes.find(
    (node) =>
      node.parentId === backgroundSend.userMessageId &&
      node.id !== backgroundSend.assistantMessageId &&
      node.id !== prepared.id,
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
      e.t === 'treePatch' &&
      e.conversationId === backgroundConv.id &&
      !e.nodes.some((node) => node.id === thirdSwipe.id) &&
      e.nodes.some(
        (node) =>
          node.parentId === backgroundSend.userMessageId &&
          node.id > thirdSwipe.id &&
          node.generationKind === 'speculative',
      ),
    'history edit refills the speculative swipe',
  );
  if (editedTree.t !== 'treePatch') throw new Error('unreachable');
  assert(
    !editedTree.nodes.some((node) => node.id === thirdSwipe.id),
    'completed speculative reply is removed after an ancestor edit',
  );
  const editedSwipe = editedTree.nodes.find(
    (node) =>
      node.parentId === backgroundSend.userMessageId &&
      node.id > thirdSwipe.id &&
      node.generationKind === 'speculative',
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
      e.t === 'treePatch' &&
      e.conversationId === backgroundConv.id &&
      !e.nodes.some((node) => node.id === editedSwipe.id) &&
      e.nodes.some((node) => node.id > editedSwipe.id && node.generationKind === 'speculative'),
    'conversation context change refills the speculative swipe',
  );
  if (invalidatedTree.t !== 'treePatch') throw new Error('unreachable');
  assert(
    !invalidatedTree.nodes.some((node) => node.id === editedSwipe.id) &&
      invalidatedTree.nodes.some(
        (node) => node.id > editedSwipe.id && node.generationKind === 'speculative',
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
    'background refill retries transient failures with backoff',
  );
  await putSettings({ backgroundSwipeGeneration: false });

  console.log('== speculative swipes wait for a subscribed client ==');
  await putSettings({ backgroundSwipeGeneration: true });
  // Fresh conversation, never subscribed: ws is still on retryConv, and each
  // ws client subscribes to at most one conversation.
  const gatedConv = await req<{ id: number }>('POST', '/api/conversations', {});
  const gatedSend = await sendMessage(gatedConv.id, 'no spectators here');
  let gatedReply: Message | undefined;
  for (let i = 0; i < 60 && !gatedReply; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const message = (await tree(gatedConv.id)).messages.find(
      (m) => m.id === gatedSend.assistantMessageId,
    );
    if (message?.status === 'done') gatedReply = message;
  }
  assert(gatedReply != null, 'unwatched foreground reply finished');
  // Grace period: an ungated onDone would spawn the speculative sibling within
  // a microtask of finalize; 1.5s is far beyond any legitimate delay.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const unwatchedSnap = await tree(gatedConv.id);
  assert(
    unwatchedSnap.messages.filter((m) => m.parentId === gatedSend.userMessageId).length === 1 &&
      !unwatchedSnap.messages.some((m) => m.generationKind === 'speculative'),
    'no speculative swipe is generated while nobody is subscribed',
  );
  ws.sub(gatedConv.id);
  await ws.waitFor(
    (e) => e.t === 'tree' && e.conversationId === gatedConv.id,
    'gated conversation tree after subscribing',
  );
  const gatedPreparedTree = await ws.waitFor(
    (e) =>
      e.t === 'treePatch' &&
      e.conversationId === gatedConv.id &&
      e.nodes.some(
        (node) =>
          node.parentId === gatedSend.userMessageId &&
          node.id !== gatedSend.assistantMessageId &&
          node.status === 'streaming',
      ),
    'subscribing starts the held-off speculative swipe',
  );
  if (gatedPreparedTree.t !== 'treePatch') throw new Error('unreachable');
  const gatedPrepared = gatedPreparedTree.nodes.find(
    (node) => node.parentId === gatedSend.userMessageId && node.id !== gatedSend.assistantMessageId,
  )!;
  const gatedFinal = await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === gatedPrepared.id,
    'gated speculative swipe finished',
  );
  assert(
    gatedFinal.t === 'final' && gatedFinal.message.generationKind === 'speculative',
    'the speculative swipe generates once a client is watching',
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
  const prefixFound = await req<{ conversation: { id: number } }[]>(
    'GET',
    `/api/search?q=${encodeURIComponent('prefi')}`,
  );
  assert(
    prefixFound.some((r) => r.conversation.id === conv2.id),
    'content search matches word prefixes',
  );
  const pctConv = await req<{ id: number }>('POST', '/api/conversations', {});
  const pctConv2 = await req<{ id: number }>('POST', '/api/conversations', {});
  await req('PATCH', `/api/conversations/${pctConv.id}`, { title: 'pct 100% marker' });
  await req('PATCH', `/api/conversations/${pctConv2.id}`, { title: 'pct 100x marker' });
  const pctFound = await req<{ conversation: { id: number } }[]>(
    'GET',
    `/api/search?q=${encodeURIComponent('100%')}`,
  );
  assert(
    pctFound.some((r) => r.conversation.id === pctConv.id) &&
      !pctFound.some((r) => r.conversation.id === pctConv2.id),
    'title search treats LIKE wildcards as literals',
  );

  ws.close();
  console.log(`\nALL ${passed} ASSERTIONS PASSED`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
