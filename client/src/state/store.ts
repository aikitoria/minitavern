import { createMemo, batch } from 'solid-js';
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

export const selectedConversation = createMemo(
  () => state.conversations.find((c) => c.id === state.selectedId) ?? null,
);

export const selectedCharacter = createMemo(() => {
  const conv = selectedConversation();
  return conv?.characterId != null
    ? (state.characters.find((c) => c.id === conv.characterId) ?? null)
    : null;
});

export const selectedPersona = createMemo(() => {
  const conv = selectedConversation();
  return conv?.personaId != null
    ? (state.personas.find((p) => p.id === conv.personaId) ?? null)
    : null;
});

/** Active path, root -> leaf, walked up via parent pointers from the active leaf. */
export const activePath = createMemo<Message[]>(() => {
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
export const childrenByParent = createMemo<Map<number, Message[]>>(() => {
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

export const streamingMessage = createMemo<Message | null>(() => {
  for (const msg of activePath()) {
    if (msg.status === 'streaming') return msg;
  }
  return null;
});

// ---- Loaders ----

const LAST_CONVERSATION_KEY = 'minitavern.lastConversationId';
let conversationsLoaded = false;
let selectionRestored = false;

function persistSelectedConversation(id: number | null): void {
  try {
    if (id == null) localStorage.removeItem(LAST_CONVERSATION_KEY);
    else localStorage.setItem(LAST_CONVERSATION_KEY, String(id));
  } catch {
    /* Storage may be unavailable in hardened/private browser contexts. */
  }
}

async function loadConversations(): Promise<void> {
  const conversations = await api.conversations();
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
}

const loaders: Record<InvalidateEntity, () => Promise<void>> = {
  conversations: loadConversations,
  characters: async () => setState('characters', reconcile(await api.characters(), { key: 'id' })),
  presets: async () => setState('presets', reconcile(await api.presets(), { key: 'id' })),
  templates: async () => setState('templates', reconcile(await api.templates(), { key: 'id' })),
  personas: async () => setState('personas', reconcile(await api.personas(), { key: 'id' })),
  endpoints: async () => setState('endpoints', reconcile(await api.endpoints(), { key: 'id' })),
  settings: async () => setState('settings', await api.settings()),
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
      }
      break;
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
      if (ev.conversationId === state.selectedId && state.tree.messages[ev.message.id]) {
        setState('tree', 'messages', ev.message.id, ev.message);
      }
      break;
  }
}

// ---- Actions ----

export function selectConversation(id: number | null): void {
  batch(() => {
    setState('selectedId', id);
    setState('sidebarOpen', false);
    setState('viewMode', 'chat');
    // conversationId is only set when the tree snapshot arrives — its absence
    // marks the tree as still loading.
    setState('tree', { conversationId: null, messages: {}, activeLeafId: null });
  });
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
    if (err instanceof ApiError && err.status === 409 && state.selectedId != null) {
      try {
        const snapshot = await api.tree(state.selectedId);
        handleServerEvent({ t: 'tree', ...snapshot });
      } catch {
        /* WebSocket invalidation remains the fallback. */
      }
    }
    return false;
  } finally {
    setState('treeNavigationPending', false);
  }
}

export async function newConversation(characterId: number | null): Promise<void> {
  const conv = await api.createConversation(characterId);
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
export const booting = createMemo(
  () =>
    !state.booted || (state.selectedId != null && state.tree.conversationId !== state.selectedId),
);
