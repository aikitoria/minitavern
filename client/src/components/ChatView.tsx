import { For, Show, createEffect, onCleanup, onMount } from 'solid-js';
import { api } from '../state/api.ts';
import {
  activePath,
  newConversation,
  selectedConversation,
  siblingsOf,
  state,
  streamingMessage,
} from '../state/store.ts';
import MessageNode from './MessageNode.tsx';
import TraceView from './TraceView.tsx';

export default function ChatView() {
  let scroller!: HTMLDivElement;
  let stickToBottom = true;

  const onScroll = () => {
    stickToBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
  };

  // Arrow keys swipe the last assistant message (like the touch gesture),
  // unless the user is typing somewhere non-empty.
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    if (state.modal !== null || state.viewMode !== 'chat' || state.selectedId == null) return;
    const target = event.target as HTMLElement;
    const editable =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      target.isContentEditable;
    if (editable) {
      // Only the empty composer passes through; anything else keeps its caret behavior.
      const isEmptyComposer =
        target instanceof HTMLTextAreaElement &&
        target.classList.contains('composer-input') &&
        target.value === '';
      if (!isEmptyComposer) return;
    }
    const path = activePath();
    const last = path[path.length - 1];
    if (!last || last.role !== 'assistant' || last.status === 'streaming' || streamingMessage())
      return;
    const siblings = siblingsOf(last);
    const idx = siblings.findIndex((m) => m.id === last.id);
    if (event.key === 'ArrowLeft') {
      if (idx > 0) void api.activate(siblings[idx - 1]!.id);
    } else if (idx < siblings.length - 1) {
      void api.activate(siblings[idx + 1]!.id);
    } else {
      void api.regenerate(last.id).catch(console.error);
    }
    event.preventDefault();
  };

  onMount(() => document.addEventListener('keydown', onKey));
  onCleanup(() => document.removeEventListener('keydown', onKey));

  // A freshly loaded conversation (reload, switch) starts at the bottom.
  createEffect(() => {
    if (state.tree.conversationId == null) return;
    stickToBottom = true;
    requestAnimationFrame(() => (scroller.scrollTop = scroller.scrollHeight));
  });

  // Content height changes (markdown settling, font swap, typing dots,
  // streaming growth) keep the view pinned while anchored at the bottom.
  const resizeObserver = new ResizeObserver(() => {
    if (stickToBottom) scroller.scrollTop = scroller.scrollHeight;
  });
  onCleanup(() => resizeObserver.disconnect());

  // Follow the stream / new messages while the user is near the bottom.
  createEffect(() => {
    const path = activePath();
    const last = path[path.length - 1];
    void last?.content.length;
    void last?.reasoning?.length;
    if (stickToBottom) scroller.scrollTop = scroller.scrollHeight;
  });

  return (
    <div class="chat" ref={scroller} onScroll={onScroll}>
      <Show
        when={selectedConversation()}
        fallback={
          // Render nothing until server state has loaded once — otherwise the
          // welcome screen flashes for a few frames on every reload.
          <div class="chat-empty" classList={{ hidden: !state.booted }}>
            <h1>MiniTavern</h1>
            <p>Small but mighty.</p>
            <button class="primary-btn" onClick={() => void newConversation(null)}>
              Start a new chat
            </button>
            <Show when={state.endpoints.length === 0}>
              <p class="hint">
                No API endpoint configured yet — open Settings (⚙) → Endpoints first.
              </p>
            </Show>
          </div>
        }
      >
        <div class="chat-inner" ref={(el) => resizeObserver.observe(el)}>
          <Show when={state.viewMode === 'chat'} fallback={<TraceView />}>
            <For each={activePath()}>{(message) => <MessageNode message={message} />}</For>
          </Show>
        </div>
      </Show>
    </div>
  );
}
