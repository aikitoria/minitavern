import { For, Show, createSignal } from 'solid-js';
import { api } from '../../state/api.ts';
import { state } from '../../state/store.ts';
import { createSavedFlash, createDetailNav } from '../../util.ts';
import MacroHelp from '../MacroHelp.tsx';

export default function PresetsTab() {
  const [selectedId, setSelectedId] = createSignal<number | 'new'>('new');
  const [saved, flashSaved] = createSavedFlash();
  const nav = createDetailNav();
  const [error, setError] = createSignal('');
  let nameEl!: HTMLInputElement;
  let contentEl!: HTMLTextAreaElement;

  const select = (id: number | 'new') => {
    nav.openDetail();
    setSelectedId(id);
    setError('');
    const preset = state.presets.find((p) => p.id === id);
    nameEl.value = preset?.name ?? '';
    contentEl.value = preset?.content ?? '';
  };

  const data = () => ({ name: nameEl.value, content: contentEl.value });

  const save = async () => {
    try {
      const id = selectedId();
      const saved = id === 'new' ? await api.createPreset(data()) : await api.patchPreset(id, data());
      setSelectedId(saved.id);
      setError('');
      flashSaved();
    } catch (err) {
      setError(String(err));
    }
  };

  const remove = async () => {
    const id = selectedId();
    if (id === 'new' || !confirm('Delete this preset?')) return;
    await api.deletePreset(id);
    select('new');
    nav.closeDetail(); // mobile: back to the list after deleting
  };

  return (
    <div class="master-detail" classList={{ 'detail-open': nav.detailOpen() }}>
      <div class="entity-list">
        <button classList={{ active: selectedId() === 'new' }} onClick={() => select('new')}>+ New preset</button>
        <For each={state.presets}>
          {(preset) => (
            <button classList={{ active: selectedId() === preset.id }} onClick={() => select(preset.id)}>
              {preset.name}
            </button>
          )}
        </For>
      </div>
      <div class="form">
        <button class="detail-back" onClick={nav.closeDetail}>‹ Back to list</button>
        <label>Name</label>
        <input ref={nameEl} placeholder="Creative writer" />
        <label>System prompt <MacroHelp /></label>
        <textarea ref={contentEl} rows="10" placeholder="You are {{char}}, …" />
        <div class="form-actions">
          <button class="primary-btn" onClick={() => void save()}>
            {selectedId() === 'new' ? 'Create' : 'Save'}
          </button>
          <button onClick={() => select(selectedId())}>Discard</button>
          <Show when={selectedId() !== 'new'}>
            <button class="danger-btn" onClick={() => void remove()}>Delete</button>
          </Show>
          <Show when={saved()}>
            <span class="saved-flash">✓ Saved</span>
          </Show>
        </div>
        <Show when={error()}>
          <p class="hint">{error()}</p>
        </Show>
      </div>
    </div>
  );
}
