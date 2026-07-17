import { For, Show, createSignal } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import type { Conversation } from '@minitavern/shared';
import { api } from '../state/api.ts';
import { selectedConversation, state } from '../state/store.ts';
import { createSavedFlash, download, errorMessage, numberOrNull } from '../util.ts';
import Modal from './Modal.tsx';

interface Draft {
  title: string;
  characterId: number | null;
  personaId: number | null;
  endpointId: number | null;
  speakerName: string | null;
}

function snapshot(conv: Conversation): Draft {
  return {
    title: conv.title,
    characterId: conv.characterId,
    personaId: conv.personaId,
    endpointId: conv.endpointId,
    speakerName: conv.speakerName,
  };
}

function Editor(props: { conv: Conversation }) {
  const [draft, setDraft] = createStore<Draft>(snapshot(props.conv));
  const [saved, flashSaved] = createSavedFlash();
  const [error, setError] = createSignal('');

  const save = async () => {
    try {
      await api.patchConversation(props.conv.id, { ...draft });
      setError('');
      flashSaved();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const discard = () => {
    const current = selectedConversation();
    if (current) setDraft(reconcile(snapshot(current)));
    setError('');
  };

  return (
    <div class="form">
      <label>Title</label>
      <input value={draft.title} onChange={(e) => setDraft('title', e.currentTarget.value)} />

      <label>Character</label>
      <select
        value={draft.characterId ?? ''}
        onChange={(e) => setDraft('characterId', numberOrNull(e.currentTarget.value))}
      >
        <option value="">Assistant (none)</option>
        <For each={state.characters}>{(ch) => <option value={ch.id}>{ch.name}</option>}</For>
      </select>

      <label>Speaker name (assistant replies; empty = character's name, also set via /char)</label>
      <input
        value={draft.speakerName ?? ''}
        onChange={(e) => setDraft('speakerName', e.currentTarget.value.trim() || null)}
        placeholder={
          state.characters.find((ch) => ch.id === draft.characterId)?.name ?? 'Assistant'
        }
      />

      <label>Persona</label>
      <select
        value={draft.personaId ?? ''}
        onChange={(e) => setDraft('personaId', numberOrNull(e.currentTarget.value))}
      >
        <option value="">— none —</option>
        <For each={state.personas}>{(p) => <option value={p.id}>{p.name}</option>}</For>
      </select>

      <label>Endpoint (overrides the global active endpoint for this conversation)</label>
      <select
        value={draft.endpointId ?? ''}
        onChange={(e) => setDraft('endpointId', numberOrNull(e.currentTarget.value))}
      >
        <option value="">— global default —</option>
        <For each={state.endpoints}>{(ep) => <option value={ep.id}>{ep.name}</option>}</For>
      </select>

      <div class="form-actions">
        <button class="primary-btn" onClick={() => void save()}>
          Save
        </button>
        <button onClick={discard}>Discard</button>
        <button onClick={() => download(`/api/conversations/${props.conv.id}/export`)}>
          Export JSON
        </button>
        <Show when={saved()}>
          <span class="saved-flash">✓ Saved</span>
        </Show>
      </div>
      <Show when={error()}>
        <p class="hint">{error()}</p>
      </Show>
    </div>
  );
}

export default function ConversationSettings() {
  return (
    <Show when={selectedConversation()}>
      {(conv) => (
        <Modal title="Conversation settings">
          <Editor conv={conv()} />
        </Modal>
      )}
    </Show>
  );
}
