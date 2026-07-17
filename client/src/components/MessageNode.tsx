import { Show, createSignal } from 'solid-js';
import type { Message } from '@minitavern/shared';
import { api } from '../state/api.ts';
import {
  navigateTree,
  selectedCharacter,
  selectedPersona,
  siblingsOf,
  state,
  toast,
} from '../state/store.ts';
import Avatar from './Avatar.tsx';
import Markdown from './Markdown.tsx';

// Shared across all messages: on touch layouts, actions show only on the last-tapped message.
const [touchedId, setTouchedId] = createSignal<number | null>(null);

export default function MessageNode(props: { message: Message }) {
  const [editing, setEditing] = createSignal(false);
  const [showReasoning, setShowReasoning] = createSignal(false);
  let editArea: HTMLTextAreaElement | undefined;

  const isUser = () => props.message.role === 'user';
  const name = () =>
    isUser()
      ? (selectedPersona()?.name ?? 'You')
      : (props.message.name ?? selectedCharacter()?.name ?? 'Assistant');
  const avatarSrc = () => (isUser() ? selectedPersona()?.avatar : selectedCharacter()?.avatar);
  const streaming = () => props.message.status === 'streaming';

  const siblings = () => siblingsOf(props.message);
  const siblingIndex = () => siblings().findIndex((m) => m.id === props.message.id);

  const switchSibling = (offset: number) => {
    const target = siblings()[siblingIndex() + offset];
    if (target) void navigateTree(() => api.activate(target.id, state.tree.activeLeafId));
  };

  const nextSiblingOrRegenerate = () => {
    if (isUser()) switchSibling(1);
    else {
      void navigateTree(() => api.advance(props.message.id, state.tree.activeLeafId));
    }
  };

  // SillyTavern-style swipe gesture on the last assistant message: swipe left
  // for the next sibling (generating a new one past the end), right for the previous.
  const [dragX, setDragX] = createSignal(0);
  const [dragging, setDragging] = createSignal(false);
  let touchX = 0;
  let touchY = 0;
  let horizontal = false;

  // Optionally show the reasoning live while the model thinks with no answer text yet.
  const reasoningOpen = () =>
    showReasoning() || (state.settings.autoExpandThinking && streaming() && !props.message.content);

  const swipeable = () =>
    !isUser() &&
    !editing() &&
    !state.treeNavigationPending &&
    state.tree.activeLeafId === props.message.id;

  const onTouchStart = (e: TouchEvent) => {
    if (!swipeable() || e.touches.length !== 1) return;
    touchX = e.touches[0]!.clientX;
    touchY = e.touches[0]!.clientY;
    horizontal = false;
    setDragging(true);
  };

  const onTouchMove = (e: TouchEvent) => {
    if (!dragging()) return;
    const dx = e.touches[0]!.clientX - touchX;
    const dy = e.touches[0]!.clientY - touchY;
    if (!horizontal) {
      if (Math.abs(dy) > 14 && Math.abs(dy) > Math.abs(dx)) {
        setDragging(false); // vertical scroll wins
        return;
      }
      horizontal = Math.abs(dx) > 14 && Math.abs(dx) > Math.abs(dy) * 1.5;
    }
    if (horizontal) setDragX(Math.max(-64, Math.min(64, dx)));
  };

  const onTouchEnd = () => {
    if (dragging() && horizontal) {
      const dx = dragX();
      if (dx <= -48) {
        nextSiblingOrRegenerate();
      } else if (dx >= 48 && !streaming()) {
        switchSibling(-1);
      }
    }
    setDragging(false);
    setDragX(0);
    horizontal = false;
  };

  const startEdit = () => {
    setEditing(true);
    queueMicrotask(() => {
      if (!editArea) return;
      editArea.value = props.message.content;
      editArea.style.height = `${editArea.scrollHeight}px`;
      editArea.focus();
    });
  };

  const saveInPlace = async () => {
    const saved = await navigateTree(() =>
      api.editMessage(props.message.id, editArea!.value, state.tree.activeLeafId),
    );
    if (saved) setEditing(false);
  };

  const saveAsBranch = async () => {
    const saved = await navigateTree(() =>
      api.editBranch(props.message.id, editArea!.value, state.tree.activeLeafId),
    );
    if (saved) setEditing(false);
  };

  const remove = () => {
    void navigateTree(() => api.deleteMessage(props.message.id, state.tree.activeLeafId));
  };

  const copy = () => void navigator.clipboard.writeText(props.message.content);

  const Tools = () => (
    <>
      <Show when={siblings().length > 1 || (!isUser() && !editing())}>
        <span class="branch-nav">
          <button
            class="icon-btn"
            disabled={
              state.treeNavigationPending || streaming() || editing() || siblingIndex() <= 0
            }
            onClick={() => switchSibling(-1)}
          >
            ‹
          </button>
          {siblingIndex() + 1}/{siblings().length}
          <button
            class="icon-btn"
            disabled={
              state.treeNavigationPending ||
              editing() ||
              (isUser() && siblingIndex() >= siblings().length - 1)
            }
            title={!isUser() && siblingIndex() >= siblings().length - 1 ? 'Regenerate' : undefined}
            onClick={nextSiblingOrRegenerate}
          >
            ›
          </button>
        </span>
      </Show>
      <Show when={!streaming() && !editing()}>
        <span class="msg-actions">
          <button class="icon-btn" title="Copy" onClick={copy}>
            ⧉
          </button>
          <button class="icon-btn" title="Edit" onClick={startEdit}>
            ✎
          </button>
          <button class="icon-btn" title="Delete branch from here" onClick={remove}>
            🗑
          </button>
        </span>
      </Show>
    </>
  );

  return (
    <article
      class="msg"
      classList={{
        'msg-user': isUser(),
        'msg-assistant': !isUser(),
        touched: touchedId() === props.message.id,
      }}
      onClick={() => setTouchedId(props.message.id)}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
    >
      <Avatar src={avatarSrc()} name={name()} />
      <div
        class="msg-body"
        style={{
          transform: dragX() !== 0 ? `translateX(${dragX()}px)` : undefined,
          transition: dragging() ? 'none' : 'transform 0.15s ease-out',
        }}
      >
        <div class="msg-head">
          <span class="msg-name">{name()}</span>
          <Show when={props.message.status === 'stopped'}>
            <span class="msg-chip">stopped</span>
          </Show>
          <Show when={streaming() && !props.message.content && !props.message.reasoning}>
            <span class="spinner spinner-wait" />
          </Show>
          <Show when={props.message.reasoning}>
            <button
              class="chip reasoning-chip"
              classList={{ 'chip-active': reasoningOpen() }}
              onClick={() => setShowReasoning(!showReasoning())}
            >
              Thinking {reasoningOpen() ? '▾' : '▸'}
              <Show when={streaming() && !props.message.content}>
                <span class="spinner" />
              </Show>
            </button>
          </Show>
          <span class="msg-tools-top">
            <Tools />
          </span>
        </div>

        <Show when={props.message.reasoning && reasoningOpen()}>
          <div class="reasoning-text">{props.message.reasoning}</div>
        </Show>

        <Show
          when={!editing()}
          fallback={
            <div class="msg-edit">
              <textarea
                ref={editArea}
                onInput={(e) => {
                  e.currentTarget.style.height = 'auto';
                  e.currentTarget.style.height = `${e.currentTarget.scrollHeight}px`;
                }}
              />
              <div class="msg-edit-actions">
                <button class="primary-btn" onClick={() => void saveAsBranch()}>
                  {isUser() ? 'Send as branch' : 'Save as branch'}
                </button>
                <button onClick={() => void saveInPlace()}>Save in place</button>
                <button onClick={() => setEditing(false)}>Cancel</button>
              </div>
            </div>
          }
        >
          <div class="msg-content">
            <Markdown content={props.message.content} streaming={streaming()} />
          </div>
        </Show>

        <Show when={props.message.status === 'error'}>
          <div class="msg-error">{props.message.genMeta?.error ?? 'Generation failed'}</div>
        </Show>
      </div>
    </article>
  );
}
