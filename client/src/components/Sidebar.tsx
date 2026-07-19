import { For, Show, createEffect, createMemo, createSignal, on } from 'solid-js';
import type { Character, Conversation } from '@minitavern/shared';
import { api } from '../state/api.ts';
import {
  deleteConversation,
  duplicateConversation,
  newConversation,
  openModal,
  selectConversation,
  state,
  toast,
  toggleGroupByCharacter,
} from '../state/store.ts';
import { errorMessage, useDismiss } from '../util.ts';
import Avatar from './Avatar.tsx';
import GearIcon from './GearIcon.tsx';
import GroupIcon from './GroupIcon.tsx';

interface SearchResult {
  conversation: Conversation;
  snippet: string | null;
}

interface ConvGroup {
  character: Character | null;
  conversations: Conversation[];
}

export default function Sidebar() {
  const [newMenuOpen, setNewMenuOpen] = createSignal(false);
  const [query, setQuery] = createSignal('');
  const [results, setResults] = createSignal<SearchResult[] | null>(null);
  let searchTimer: number | undefined;
  let newChatWrap: HTMLDivElement | undefined;

  useDismiss(
    () => newChatWrap,
    newMenuOpen,
    () => setNewMenuOpen(false),
  );

  // Apply only if the query hasn't changed while the request was in flight.
  const runSearch = (q: string) => {
    void api
      .search(q)
      .then((r) => {
        if (query().trim() === q) setResults(r);
      })
      .catch(console.error);
  };

  const onSearchInput = (value: string) => {
    setQuery(value);
    clearTimeout(searchTimer);
    const q = value.trim();
    if (!q) {
      setResults(null);
      return;
    }
    searchTimer = window.setTimeout(() => runSearch(q), 250);
  };

  // Results otherwise only refresh on typing — re-run the query when the
  // conversation list changes (a delete/rename elsewhere would leave stale,
  // still-clickable entries).
  createEffect(
    on(
      () => state.conversations.map((c) => `${c.id}:${c.title}`).join('\n'),
      () => {
        const q = query().trim();
        if (q && results()) runSearch(q);
      },
      { defer: true },
    ),
  );

  const create = (characterId: number | null) => {
    setNewMenuOpen(false);
    void newConversation(characterId);
  };

  const remove = async (id: number, event: MouseEvent) => {
    event.stopPropagation();
    if (!confirm('Delete this conversation?')) return;
    try {
      await deleteConversation(id);
    } catch (err) {
      toast(errorMessage(err));
    }
  };

  const duplicate = async (id: number, event: MouseEvent) => {
    event.stopPropagation();
    try {
      await duplicateConversation(id);
    } catch (err) {
      toast(errorMessage(err));
    }
  };

  const characterOf = (characterId: number | null) =>
    characterId != null ? state.characters.find((c) => c.id === characterId) : undefined;

  // state.conversations is sorted by updatedAt desc, so first-appearance
  // order gives groups ordered by their most recent conversation and keeps
  // each group's conversations in the same order as the flat list.
  const convGroups = createMemo<ConvGroup[]>(() => {
    const byKey = new Map<string, ConvGroup>();
    const groups: ConvGroup[] = [];
    for (const conv of state.conversations) {
      const character = characterOf(conv.characterId) ?? null;
      const key = character ? String(character.id) : 'none';
      let group = byKey.get(key);
      if (!group) {
        group = { character, conversations: [] };
        byKey.set(key, group);
        groups.push(group);
      }
      group.conversations.push(conv);
    }
    return groups;
  });

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
        class="icon-btn conv-duplicate"
        title="Duplicate"
        onClick={(e) => void duplicate(props.conv.id, e)}
      >
        ⧉
      </button>
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
        <span class="sidebar-head-actions">
          <button
            class="icon-btn"
            classList={{ 'icon-btn-active': state.groupByCharacter }}
            title="Group by character"
            onClick={toggleGroupByCharacter}
          >
            <GroupIcon />
          </button>
          <button class="icon-btn" title="Settings" onClick={() => openModal('settings')}>
            <GearIcon />
          </button>
        </span>
      </div>

      <div class="new-chat-wrap" ref={newChatWrap}>
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
          fallback={
            <Show
              when={state.groupByCharacter}
              fallback={<For each={state.conversations}>{(conv) => <ConvItem conv={conv} />}</For>}
            >
              <For each={convGroups()}>
                {(group) => (
                  <section class="conv-group">
                    <div class="conv-group-head">
                      <Show
                        when={group.character}
                        fallback={<span class="avatar avatar-fallback">A</span>}
                      >
                        {(character) => <Avatar src={character().avatar} name={character().name} />}
                      </Show>
                      <span class="conv-group-name">{group.character?.name ?? 'No character'}</span>
                    </div>
                    <For each={group.conversations}>{(conv) => <ConvItem conv={conv} />}</For>
                  </section>
                )}
              </For>
            </Show>
          }
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
