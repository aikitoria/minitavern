import { Show, createSignal } from 'solid-js';
import { api } from '../state/api.ts';
import {
  openModal,
  selectedCharacter,
  selectedConversation,
  personasEnabled,
  selectedPersona,
  setState,
  state,
  toast,
  toggleSidebar,
} from '../state/store.ts';
import { errorMessage } from '../util.ts';
import Avatar from './Avatar.tsx';
import GearIcon from './GearIcon.tsx';
import TraceIcon from './TraceIcon.tsx';

export default function Header() {
  const [editing, setEditing] = createSignal(false);
  let titleInput: HTMLInputElement | undefined;

  // The endpoint generations actually use: conversation override, else global.
  const activeEndpoint = () => {
    const id = selectedConversation()?.endpointId ?? state.settings.activeEndpointId;
    return id != null ? state.endpoints.find((e) => e.id === id) : undefined;
  };

  const startRename = () => {
    setEditing(true);
    queueMicrotask(() => {
      if (!titleInput) return;
      titleInput.value = selectedConversation()?.title ?? '';
      titleInput.focus();
      titleInput.select();
    });
  };

  const commitRename = () => {
    if (!editing()) return; // Enter commits and the input's blur would commit again
    const conv = selectedConversation();
    const title = titleInput?.value.trim();
    if (conv && title && title !== conv.title) {
      void api.patchConversation(conv.id, { title }).catch((err) => toast(errorMessage(err)));
    }
    setEditing(false);
  };

  return (
    <header class="header">
      <button class="icon-btn menu-btn" title="Conversations" onClick={toggleSidebar}>
        ☰
      </button>
      <Show when={selectedConversation()} fallback={<span class="header-title">MiniTavern</span>}>
        {(conv) => (
          <>
            <Avatar
              src={selectedCharacter()?.avatar}
              name={selectedCharacter()?.name ?? 'Assistant'}
            />
            <div class="header-info">
              <Show
                when={!editing()}
                fallback={
                  <input
                    ref={titleInput}
                    class="header-title-input"
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename();
                      if (e.key === 'Escape') setEditing(false);
                    }}
                  />
                }
              >
                <span class="header-title" title="Click to rename" onClick={startRename}>
                  {conv().title}
                </span>
              </Show>
              <div class="header-chips">
                <Show when={(selectedCharacter()?.name ?? 'Assistant') !== conv().title}>
                  <button class="chip" onClick={() => openModal('conversation')}>
                    {selectedCharacter()?.name ?? 'Assistant'}
                  </button>
                </Show>
                <Show when={!activeEndpoint() || !activeEndpoint()!.model}>
                  <button class="chip chip-warn" onClick={() => openModal('settings')}>
                    {activeEndpoint() ? 'no model' : 'no endpoint'}
                  </button>
                </Show>
                <Show when={activeEndpoint()}>
                  {(endpoint) => (
                    <button class="chip" onClick={() => openModal('settings')}>
                      {endpoint().name}
                    </button>
                  )}
                </Show>
                <Show when={personasEnabled() && selectedPersona()}>
                  {(persona) => (
                    <button class="chip" onClick={() => openModal('conversation')}>
                      as {persona().name}
                    </button>
                  )}
                </Show>
              </div>
            </div>
            <button
              class="icon-btn"
              classList={{ 'icon-btn-active': state.viewMode === 'trace' }}
              title="Toggle prompt trace"
              onClick={() => setState('viewMode', state.viewMode === 'chat' ? 'trace' : 'chat')}
            >
              <TraceIcon />
            </button>
            <button
              class="icon-btn"
              title="Conversation settings"
              onClick={() => openModal('conversation')}
            >
              <GearIcon />
            </button>
          </>
        )}
      </Show>
    </header>
  );
}
