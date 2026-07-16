import { For, Show, createSignal } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import type { Settings } from '@minitavern/shared';
import { api } from '../../state/api.ts';
import { state } from '../../state/store.ts';
import { createSavedFlash } from '../../util.ts';

function snapshot(): Settings {
  return { ...state.settings };
}

export default function GeneralTab() {
  const [draft, setDraft] = createStore<Settings>(snapshot());
  const [saved, flashSaved] = createSavedFlash();
  const [error, setError] = createSignal('');

  const numOrNull = (value: string) => (value === '' ? null : Number(value));

  const save = async () => {
    try {
      await api.putSettings({ ...draft });
      setError('');
      flashSaved();
    } catch (err) {
      setError(String(err));
    }
  };

  const discard = () => {
    setDraft(reconcile(snapshot()));
    setError('');
  };

  return (
    <div class="form">
      <label>Active endpoint (all generations go through this)</label>
      <select
        value={draft.activeEndpointId ?? ''}
        onChange={(e) => setDraft('activeEndpointId', numOrNull(e.currentTarget.value))}
      >
        <option value="">— none —</option>
        <For each={state.endpoints}>{(ep) => <option value={ep.id}>{ep.name}</option>}</For>
      </select>
      <p class="hint">
        Model and sampling settings are configured per endpoint in the Endpoints tab.
      </p>

      <label>Default system prompt preset</label>
      <select
        value={draft.defaultPresetId ?? ''}
        onChange={(e) => setDraft('defaultPresetId', numOrNull(e.currentTarget.value))}
      >
        <option value="">— none —</option>
        <For each={state.presets}>{(p) => <option value={p.id}>{p.name}</option>}</For>
      </select>

      <label>Default persona</label>
      <select
        value={draft.defaultPersonaId ?? ''}
        onChange={(e) => setDraft('defaultPersonaId', numOrNull(e.currentTarget.value))}
      >
        <option value="">— none —</option>
        <For each={state.personas}>{(p) => <option value={p.id}>{p.name}</option>}</For>
      </select>

      <label>Default prompt template</label>
      <select
        value={draft.defaultTemplateId ?? ''}
        onChange={(e) => setDraft('defaultTemplateId', numOrNull(e.currentTarget.value))}
      >
        <For each={state.templates}>{(t) => <option value={t.id}>{t.name}</option>}</For>
      </select>

      <label class="check-row">
        <input
          type="checkbox"
          checked={draft.autoExpandThinking}
          onChange={(e) => setDraft('autoExpandThinking', e.currentTarget.checked)}
        />
        Auto-expand thinking while the model reasons (collapses once the reply starts)
      </label>

      <div class="form-actions">
        <button class="primary-btn" onClick={() => void save()}>
          Save
        </button>
        <button onClick={discard}>Discard</button>
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
