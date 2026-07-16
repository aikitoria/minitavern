import { For, Show, createSignal } from 'solid-js';
import { api } from '../state/api.ts';
import {
  newConversation, openModal, selectConversation, setState, state,
} from '../state/store.ts';
import Avatar from './Avatar.tsx';

export default function Sidebar() {
  const [newMenuOpen, setNewMenuOpen] = createSignal(false);

  const create = (characterId: number | null) => {
    setNewMenuOpen(false);
    void newConversation(characterId);
  };

  const remove = async (id: number, event: MouseEvent) => {
    event.stopPropagation();
    if (!confirm('Delete this conversation?')) return;
    await api.deleteConversation(id);
    if (state.selectedId === id) selectConversation(null);
  };

  const characterOf = (characterId: number | null) =>
    characterId != null ? state.characters.find((c) => c.id === characterId) : undefined;

  return (
    <aside class="sidebar" classList={{ open: state.sidebarOpen }}>
      <div class="sidebar-head">
        <span class="brand">
          MiniTavern
          <span class="conn-dot" classList={{ ok: state.connected }} title={state.connected ? 'Connected' : 'Disconnected'} />
        </span>
        <button class="icon-btn" title="Settings" onClick={() => openModal('settings')}>⚙</button>
      </div>

      <div class="new-chat-wrap">
        <button class="new-chat-btn" onClick={() => setNewMenuOpen(!newMenuOpen())}>
          + New chat
        </button>
        <Show when={newMenuOpen()}>
          <div class="new-chat-menu">
            <button onClick={() => create(null)}>
              <span class="avatar avatar-fallback">A</span> Assistant
            </button>
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

      <nav class="conv-list">
        <For each={state.conversations}>
          {(conv) => (
            <div
              class="conv-item"
              classList={{ active: conv.id === state.selectedId }}
              onClick={() => selectConversation(conv.id)}
            >
              <Show
                when={characterOf(conv.characterId)}
                fallback={<span class="avatar avatar-fallback">A</span>}
              >
                {(character) => <Avatar src={character().avatar} name={character().name} />}
              </Show>
              <span class="conv-title">{conv.title}</span>
              <button class="icon-btn conv-delete" title="Delete" onClick={(e) => void remove(conv.id, e)}>
                ✕
              </button>
            </div>
          )}
        </For>
      </nav>
    </aside>
  );
}
