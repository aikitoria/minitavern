import { For, Show, createSignal } from 'solid-js';
import type { Conversation } from '@minitavern/shared';
import { api } from '../state/api.ts';
import {
  newConversation,
  openModal,
  selectConversation,
  setState,
  state,
  toast,
} from '../state/store.ts';
import { errorMessage } from '../util.ts';
import Avatar from './Avatar.tsx';
import GearIcon from './GearIcon.tsx';

interface SearchResult {
  conversation: Conversation;
  snippet: string | null;
}

export default function Sidebar() {
  const [newMenuOpen, setNewMenuOpen] = createSignal(false);
  const [query, setQuery] = createSignal('');
  const [results, setResults] = createSignal<SearchResult[] | null>(null);
  let searchTimer: number | undefined;

  const onSearchInput = (value: string) => {
    setQuery(value);
    clearTimeout(searchTimer);
    const q = value.trim();
    if (!q) {
      setResults(null);
      return;
    }
    searchTimer = window.setTimeout(() => {
      void api
        .search(q)
        .then((r) => {
          if (query().trim() === q) setResults(r);
        })
        .catch(console.error);
    }, 250);
  };

  const create = (characterId: number | null) => {
    setNewMenuOpen(false);
    void newConversation(characterId);
  };

  const remove = async (id: number, event: MouseEvent) => {
    event.stopPropagation();
    if (!confirm('Delete this conversation?')) return;
    try {
      await api.deleteConversation(id);
      if (state.selectedId === id) selectConversation(null);
    } catch (err) {
      toast(errorMessage(err));
    }
  };

  const characterOf = (characterId: number | null) =>
    characterId != null ? state.characters.find((c) => c.id === characterId) : undefined;

  const ConvItem = (props: { conv: Conversation; snippet?: string | null; expanded?: boolean }) => (
    <div
      class="conv-item"
      classList={{
        active: props.conv.id === state.selectedId,
        'search-result': props.expanded,
      }}
      onClick={() => selectConversation(props.conv.id)}
    >
      <Show
        when={characterOf(props.conv.characterId)}
        fallback={<span class="avatar avatar-fallback">A</span>}
      >
        {(character) => <Avatar src={character().avatar} name={character().name} />}
      </Show>
      <span class="conv-body">
        <span class="conv-title">{props.conv.title}</span>
        <Show when={props.snippet}>
          <span class="conv-snippet">{props.snippet}</span>
        </Show>
      </span>
      <button
        class="icon-btn conv-delete"
        title="Delete"
        onClick={(e) => void remove(props.conv.id, e)}
      >
        ✕
      </button>
    </div>
  );

  return (
    <aside class="sidebar" classList={{ open: state.sidebarOpen }}>
      <div class="sidebar-head">
        <span class="brand">
          MiniTavern
          <span
            class="conn-dot"
            classList={{ ok: state.connected }}
            title={state.connected ? 'Connected' : 'Disconnected'}
          />
        </span>
        <button class="icon-btn" title="Settings" onClick={() => openModal('settings')}>
          <GearIcon />
        </button>
      </div>

      <div class="new-chat-wrap">
        <button class="new-chat-btn" onClick={() => setNewMenuOpen(!newMenuOpen())}>
          + New chat
        </button>
        <Show when={newMenuOpen()}>
          <div class="new-chat-menu">
            {/* Characterless fallback, only when no characters exist (Assistant is normally a seeded character). */}
            <Show when={state.characters.length === 0}>
              <button onClick={() => create(null)}>
                <span class="avatar avatar-fallback">A</span> Assistant
              </button>
            </Show>
            <For each={state.characters}>
              {(character) => (
                <button onClick={() => create(character.id)}>
                  <Avatar src={character.avatar} name={character.name} /> {character.name}
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>

      <div class="search-wrap">
        <input
          class="search-input"
          placeholder="Search…"
          value={query()}
          onInput={(e) => onSearchInput(e.currentTarget.value)}
        />
      </div>

      <nav class="conv-list">
        <Show
          when={results()}
          fallback={<For each={state.conversations}>{(conv) => <ConvItem conv={conv} />}</For>}
        >
          {(found) => (
            <>
              <Show when={found().length === 0}>
                <p class="hint search-empty">No matches.</p>
              </Show>
              <For each={found()}>
                {(r) => <ConvItem conv={r.conversation} snippet={r.snippet} expanded />}
              </For>
            </>
          )}
        </Show>
      </nav>
    </aside>
  );
}
