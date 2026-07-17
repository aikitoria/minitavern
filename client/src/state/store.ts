import { createMemo, createRoot, createSignal, batch } from 'solid-js';
import { createStore, produce, reconcile } from 'solid-js/store';
import type {
  Character,
  Conversation,
  Endpoint,
  InvalidateEntity,
  Message,
  Persona,
  Preset,
  ServerEvent,
  Settings,
  Template,
} from '@minitavern/shared';
import { DEFAULT_SETTINGS } from '@minitavern/shared';
import { api, ApiError } from './api.ts';
import { subscribe } from './ws.ts';

export type ModalKind = 'settings' | 'conversation' | null;

interface TreeState {
  conversationId: number | null;
  messages: Record<number, Message>;
  activeLeafId: number | null;
}

interface AppState {
  conversations: Conversation[];
  characters: Character[];
  presets: Preset[];
  templates: Template[];
  personas: Persona[];
  endpoints: Endpoint[];
  settings: Settings;
  connected: boolean;
  booted: boolean;
  selectedId: number | null;
  sidebarOpen: boolean;
  modal: ModalKind;
  /** 'trace' replaces the timeline with the assembled upstream request. */
  viewMode: 'chat' | 'trace';
  treeNavigationPending: boolean;
  toasts: { id: number; text: string }[];
  tree: TreeState;
}

export const [state, setState] = createStore<AppState>({
  conversations: [],
  characters: [],
  presets: [],
  templates: [],
  personas: [],
  endpoints: [],
  settings: { ...DEFAULT_SETTINGS },
  connected: false,
  booted: false,
  selectedId: null,
  sidebarOpen: false,
  modal: null,
  viewMode: 'chat',
  treeNavigationPending: false,
  toasts: [],
  tree: { conversationId: null, messages: {}, activeLeafId: null },
});

let toastCounter = 0;

/** Transient error/info notification, bottom corner, auto-dismisses. */
export function toast(text: string): void {
  const id = ++toastCounter;
  setState('toasts', (toasts) => [...toasts, { id, text }]);
  setTimeout(() => setState('toasts', (toasts) => toasts.filter((t) => t.id !== id)), 4500);
}

// ---- Derived state ----

/**
 * App-lifetime memo: rooted explicitly (and intentionally never disposed) so
 * Solid's dev mode doesn't warn about computations created outside a root.
 */
const globalMemo = <T>(fn: () => T) => createRoot(() => createMemo(fn));

export const selectedConversation = globalMemo(
  () => state.conversations.find((c) => c.id === state.selectedId) ?? null,
);

export const selectedCharacter = globalMemo(() => {
  const conv = selectedConversation();
  return conv?.characterId != null
    ? (state.characters.find((c) => c.id === conv.characterId) ?? null)
    : null;
});

export const selectedPersona = globalMemo(() => {
  const conv = selectedConversation();
  return conv?.personaId != null
    ? (state.personas.find((p) => p.id === conv.personaId) ?? null)
    : null;
});

/** Whether the effective template of the selected chat uses personas at all. */
export const personasEnabled = globalMemo(() => {
  const character = selectedCharacter();
  if (character?.customTemplate) return character.customTemplate.usesPersonas;
  const templateId = character?.templateId ?? state.settings.defaultTemplateId;
  const template =
    templateId != null ? state.templates.find((t) => t.id === templateId) : undefined;
  return template?.usesPersonas ?? true;
});

/** Active path, root -> leaf, walked up via parent pointers from the active leaf. */
export const activePath = globalMemo<Message[]>(() => {
  const tree = state.tree;
  const path: Message[] = [];
  let cur = tree.activeLeafId;
  while (cur != null) {
    const msg = tree.messages[cur];
    if (!msg) break;
    path.push(msg);
    cur = msg.parentId;
  }
  return path.reverse();
});

/** parentId (or -1 for roots) -> ordered children; drives the < n/m > branch navigation. */
export const childrenByParent = globalMemo<Map<number, Message[]>>(() => {
  const map = new Map<number, Message[]>();
  for (const msg of Object.values(state.tree.messages)) {
    const key = msg.parentId ?? -1;
    const list = map.get(key);
    if (list) list.push(msg);
    else map.set(key, [msg]);
  }
  for (const list of map.values()) list.sort((a, b) => a.id - b.id);
  return map;
});

export function siblingsOf(message: Message): Message[] {
  return childrenByParent().get(message.parentId ?? -1) ?? [];
}

export const streamingMessage = globalMemo<Message | null>(() => {
  for (const msg of activePath()) {
    if (msg.status === 'streaming') return msg;
  }
  return null;
});

// ---- Loaders ----

const LAST_CONVERSATION_KEY = 'minitavern.lastConversationId';
let conversationsLoaded = false;
let selectionRestored = false;
/** First tree snapshot applied — the boot cover only waits for the initial
 * (hash-restored) tree, not for every later conversation switch. */
const [initialTreeLoaded, setInitialTreeLoaded] = createSignal(false);

function persistSelectedConversation(id: number | null): void {
  try {
    if (id == null) localStorage.removeItem(LAST_CONVERSATION_KEY);
    else localStorage.setItem(LAST_CONVERSATION_KEY, String(id));
  } catch {
    /* Storage may be unavailable in hardened/private browser contexts. */
  }
}

// Refetches can overlap (invalidate bursts, reconnect loadAll racing an
// invalidate) and resolve out of order; applying an older response after a
// newer one — or after a local write like newConversation's insert — would
// revert state, so each entity tracks a fetch sequence and stale responses
// are dropped.
const fetchSeq = new Map<InvalidateEntity, number>();

/** Marks now as the entity's newest state: any in-flight refetch started
 * earlier is stale and its response will be discarded. */
function bumpFetchSeq(entity: InvalidateEntity): number {
  const seq = (fetchSeq.get(entity) ?? 0) + 1;
  fetchSeq.set(entity, seq);
  return seq;
}

function loader<T>(
  entity: InvalidateEntity,
  fetch: () => Promise<T>,
  apply: (data: T) => void,
): () => Promise<void> {
  return async () => {
    const seq = bumpFetchSeq(entity);
    const data = await fetch();
    if (fetchSeq.get(entity) !== seq) return; // superseded while in flight
    apply(data);
  };
}

const loaders: Record<InvalidateEntity, () => Promise<void>> = {
  conversations: loader('conversations', api.conversations, (conversations) => {
    conversationsLoaded = true;
    setState('conversations', reconcile(conversations, { key: 'id' }));
    if (
      selectionRestored &&
      state.selectedId != null &&
      !conversations.some((conversation) => conversation.id === state.selectedId)
    ) {
      selectConversation(null);
      toast('This conversation was deleted on another device.');
    }
  }),
  characters: loader('characters', api.characters, (data) =>
    setState('characters', reconcile(data, { key: 'id' })),
  ),
  presets: loader('presets', api.presets, (data) =>
    setState('presets', reconcile(data, { key: 'id' })),
  ),
  templates: loader('templates', api.templates, (data) =>
    setState('templates', reconcile(data, { key: 'id' })),
  ),
  personas: loader('personas', api.personas, (data) =>
    setState('personas', reconcile(data, { key: 'id' })),
  ),
  endpoints: loader('endpoints', api.endpoints, (data) =>
    setState('endpoints', reconcile(data, { key: 'id' })),
  ),
  settings: loader('settings', api.settings, (data) => setState('settings', data)),
};

export async function loadAll(): Promise<void> {
  await Promise.all(Object.values(loaders).map((load) => load().catch(console.error)));
  if (!selectionRestored && conversationsLoaded) restoreConversationSelection();
  setState('booted', true);
}

// ---- WS event handling ----

export function handleServerEvent(ev: ServerEvent): void {
  switch (ev.t) {
    case 'hello':
      break;
    case 'invalidate':
      loaders[ev.entity]().catch(console.error);
      break;
    case 'tree':
      if (ev.conversationId === state.selectedId) {
        setInitialTreeLoaded(true);
        batch(() => {
          setState('tree', 'conversationId', ev.conversationId);
          setState('tree', 'activeLeafId', ev.activeLeafId);
          // Reconcile keeps object identity for unchanged messages so the DOM
          // (and scroll position) survives branch switches.
          setState(
            'tree',
            'messages',
            reconcile(Object.fromEntries(ev.messages.map((m) => [m.id, m])), { key: 'id' }),
          );
        });
        // A render may have finished while we were disconnected — progress for
        // messages the snapshot shows as no longer pending is stale and must
        // not front-run the next render on the same message.
        setImageProgress((progress) => {
          const pending = new Set(ev.messages.filter((m) => m.imagePending).map((m) => m.id));
          if (Object.keys(progress).every((mid) => pending.has(Number(mid)))) return progress;
          return Object.fromEntries(
            Object.entries(progress).filter(([mid]) => pending.has(Number(mid))),
          );
        });
      }
      break;
    case 'treePatch': {
      // Patches only apply on top of a full snapshot for the same conversation.
      if (ev.conversationId !== state.selectedId || state.tree.conversationId !== ev.conversationId)
        break;
      const bodies = new Map(ev.messages.map((m) => [m.id, m]));
      // A node we've never seen and no body for means a missed frame — resync.
      if (ev.nodes.some((node) => !bodies.has(node.id) && !state.tree.messages[node.id])) {
        resyncTree();
        break;
      }
      batch(() => {
        setState('tree', 'activeLeafId', ev.activeLeafId);
        setState(
          'tree',
          'messages',
          produce((messages) => {
            const alive = new Set(ev.nodes.map((node) => node.id));
            for (const key of Object.keys(messages)) {
              if (!alive.has(Number(key))) delete messages[Number(key)];
            }
            for (const node of ev.nodes) {
              const body = bodies.get(node.id);
              if (body) {
                const existing = messages[node.id];
                // Merge into the existing object: replacing it would change
                // identity and remount the whole MessageNode (destroying UI
                // state like open viewers) since the timeline is keyed by
                // reference.
                if (existing) Object.assign(existing, body);
                else messages[node.id] = body;
                if (!body.imagePending) clearImageProgress(node.id);
              } else {
                const msg = messages[node.id]!;
                // parentId too: splice deletions and block moves reparent
                // messages without resending their bodies.
                msg.parentId = node.parentId;
                msg.activeChildId = node.activeChildId;
                msg.status = node.status;
                msg.generationKind = node.generationKind;
              }
            }
          }),
        );
      });
      break;
    }
    case 'delta': {
      if (!state.tree.messages[ev.mid]) break;
      setState(
        'tree',
        'messages',
        ev.mid,
        produce((msg) => {
          if (ev.d) msg.content += ev.d;
          if (ev.r) msg.reasoning = (msg.reasoning ?? '') + ev.r;
        }),
      );
      break;
    }
    case 'final':
      // Surface upstream API failures (e.g. context length exceeded) loudly.
      // Speculative swipes retry quietly in the background.
      if (ev.message.status === 'error' && ev.message.generationKind !== 'speculative') {
        toast(ev.message.genMeta?.error ?? 'Generation failed');
      }
      if (ev.conversationId === state.selectedId && state.tree.messages[ev.message.id]) {
        setState('tree', 'messages', ev.message.id, ev.message);
        if (!ev.message.imagePending) clearImageProgress(ev.message.id);
      }
      break;
    case 'imageProgress':
      if (ev.conversationId !== state.selectedId) break;
      setImageProgress((progress) => ({ ...progress, [ev.mid]: { value: ev.value, max: ev.max } }));
      break;
  }
}

/** Per-message image render progress (ephemeral; only read while imagePending). */
export const [imageProgress, setImageProgress] = createSignal<
  Record<number, { value: number; max: number }>
>({});

/** Dropped once a body shows the render finished — a later render on the same
 * message must not open with the previous one's final progress. */
function clearImageProgress(mid: number): void {
  setImageProgress((progress) => {
    if (!(mid in progress)) return progress;
    const next = { ...progress };
    delete next[mid];
    return next;
  });
}

// ---- Actions ----

/**
 * Re-request the tree by re-subscribing: the server pushes a fresh snapshot
 * on repeat subs, and it arrives in-order with patches/deltas on the WS
 * channel — a REST fetch could race a concurrent patch and revert an edited
 * body that would never be resent.
 */
function resyncTree(): void {
  if (state.selectedId != null) subscribe(state.selectedId);
}

export function selectConversation(id: number | null): void {
  if (id === state.selectedId) {
    setState('sidebarOpen', false); // mobile: still dismiss the sidebar
    return;
  }
  batch(() => {
    setState('selectedId', id);
    setState('sidebarOpen', false);
    setState('viewMode', 'chat');
    // conversationId is only set when the tree snapshot arrives — its absence
    // marks the tree as still loading.
    setState('tree', { conversationId: null, messages: {}, activeLeafId: null });
  });
  // A swipe animation pending in the previous conversation must not leak into
  // this one's freshly mounted nodes.
  setPendingSwipe(null);
  setImageProgress({});
  subscribe(id);
  persistSelectedConversation(id);
  history.replaceState(null, '', id != null ? `#${id}` : '#');
}

export async function navigateTree(action: () => Promise<unknown>): Promise<boolean> {
  if (state.treeNavigationPending) return false;
  setState('treeNavigationPending', true);
  try {
    await action();
    return true;
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err));
    if (err instanceof ApiError && err.status === 409) resyncTree();
    return false;
  } finally {
    setState('treeNavigationPending', false);
  }
}

// ---- Swipe navigation (shared by the touch gesture, ‹ › buttons and arrow keys) ----

export interface PendingSwipe {
  /** Sibling group the swipe happens in (-1 for root messages). */
  parentKey: number;
  /** The message sliding out. */
  outgoingId: number;
  /** 1 = next sibling (out to the left, in from the right), -1 = previous. */
  dir: 1 | -1;
}

export const [pendingSwipe, setPendingSwipe] = createSignal<PendingSwipe | null>(null);

/** Set to a message id to ask that MessageNode to open its in-place editor (composer ↑ key). */
export const [editRequestId, setEditRequestId] = createSignal<number | null>(null);

/**
 * Switch to a sibling with a directional slide: the outgoing message animates
 * fully out while `pendingSwipe` is set, and the incoming sibling slides in
 * from the opposite side as it mounts. Swiping an assistant message past the
 * end generates a new sibling (advance).
 */
export async function swipeToSibling(message: Message, dir: 1 | -1): Promise<void> {
  if (state.treeNavigationPending) return;
  const siblings = siblingsOf(message);
  const idx = siblings.findIndex((m) => m.id === message.id);
  let action: (() => Promise<unknown>) | null = null;
  // Only assistant messages generate new siblings past the end; user and tool
  // messages can just switch between existing ones.
  if (dir === -1 || message.role !== 'assistant') {
    const target = siblings[idx + dir];
    if (target) action = () => api.activate(target.id, state.tree.activeLeafId);
  } else {
    action = () => api.advance(message.id, state.tree.activeLeafId);
  }
  if (!action) return;
  setPendingSwipe({ parentKey: message.parentId ?? -1, outgoingId: message.id, dir });
  const ok = await navigateTree(action);
  if (!ok) {
    setPendingSwipe(null); // spring back
    return;
  }
  // The incoming sibling consumes this as it mounts; drop it shortly after so
  // unrelated mounts never animate.
  setTimeout(() => {
    setPendingSwipe((p) => (p?.outgoingId === message.id ? null : p));
  }, 400);
}

export async function newConversation(characterId: number | null): Promise<void> {
  const conv = await api.createConversation(characterId);
  // Insert immediately so Header/ChatView never flash the empty state while
  // the invalidate-driven refetch is in flight; mark refetches started before
  // this write as stale so they can't briefly remove the row again.
  bumpFetchSeq('conversations');
  setState('conversations', (list) => [conv, ...list]);
  selectConversation(conv.id);
}

export function restoreConversationSelection(): void {
  selectionRestored = true;
  const exists = (id: number) => state.conversations.some((conversation) => conversation.id === id);
  const hashId = Number(location.hash.slice(1));
  let storedId = 0;
  try {
    storedId = Number(localStorage.getItem(LAST_CONVERSATION_KEY));
  } catch {
    /* Ignore unavailable storage. */
  }
  const id =
    Number.isSafeInteger(hashId) && hashId > 0 && exists(hashId)
      ? hashId
      : Number.isSafeInteger(storedId) && storedId > 0 && exists(storedId)
        ? storedId
        : null;
  selectConversation(id);
}

export function openModal(modal: ModalKind): void {
  setState('modal', modal);
}

export function toggleSidebar(): void {
  setState('sidebarOpen', (open) => !open);
}

/** True until the initial server state (and the hash-selected tree, if any) has arrived. */
export const booting = globalMemo(
  () =>
    !state.booted ||
    (!initialTreeLoaded() &&
      state.selectedId != null &&
      state.tree.conversationId !== state.selectedId),
);
