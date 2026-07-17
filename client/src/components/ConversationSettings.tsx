import { Show, createSignal } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import type { Conversation } from '@minitavern/shared';
import { api } from '../state/api.ts';
import { selectedConversation, state } from '../state/store.ts';
import { createSavedFlash, download, errorMessage, numberOrNull } from '../util.ts';
import Modal from './Modal.tsx';
import Select from './Select.tsx';

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
      <Select
        value={draft.characterId?.toString() ?? ''}
        onChange={(v) => setDraft('characterId', numberOrNull(v))}
        options={[
          { value: '', label: 'Assistant (none)' },
          ...state.characters.map((ch) => ({ value: String(ch.id), label: ch.name })),
        ]}
      />

      <label>Speaker name (assistant replies; empty = character's name, also set via /char)</label>
      <input
        value={draft.speakerName ?? ''}
        onChange={(e) => setDraft('speakerName', e.currentTarget.value.trim() || null)}
        placeholder={
          state.characters.find((ch) => ch.id === draft.characterId)?.name ?? 'Assistant'
        }
      />

      <label>Persona</label>
      <Select
        value={draft.personaId?.toString() ?? ''}
        onChange={(v) => setDraft('personaId', numberOrNull(v))}
        options={[
          { value: '', label: '— none —' },
          ...state.personas.map((p) => ({ value: String(p.id), label: p.name })),
        ]}
      />

      <label>Endpoint (overrides the global active endpoint for this conversation)</label>
      <Select
        value={draft.endpointId?.toString() ?? ''}
        onChange={(v) => setDraft('endpointId', numberOrNull(v))}
        options={[
          { value: '', label: '— global default —' },
          ...state.endpoints.map((ep) => ({ value: String(ep.id), label: ep.name })),
        ]}
      />

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
