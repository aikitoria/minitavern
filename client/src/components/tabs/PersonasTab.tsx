import { For, Show, createSignal } from 'solid-js';
import { api } from '../../state/api.ts';
import { state } from '../../state/store.ts';
import { createSavedFlash, createDetailNav } from '../../util.ts';
import Avatar from '../Avatar.tsx';
import MacroHelp from '../MacroHelp.tsx';

export default function PersonasTab() {
  const [selectedId, setSelectedId] = createSignal<number | 'new'>('new');
  const [saved, flashSaved] = createSavedFlash();
  const nav = createDetailNav();
  const [error, setError] = createSignal('');
  let nameEl!: HTMLInputElement;
  let descriptionEl!: HTMLTextAreaElement;
  let avatarInput!: HTMLInputElement;

  const selected = () => state.personas.find((p) => p.id === selectedId());

  const select = (id: number | 'new') => {
    nav.openDetail();
    setSelectedId(id);
    setError('');
    const persona = state.personas.find((p) => p.id === id);
    nameEl.value = persona?.name ?? '';
    descriptionEl.value = persona?.description ?? '';
  };

  const data = () => ({ name: nameEl.value, description: descriptionEl.value });

  const save = async () => {
    try {
      const id = selectedId();
      const saved = id === 'new' ? await api.createPersona(data()) : await api.patchPersona(id, data());
      setSelectedId(saved.id);
      setError('');
      flashSaved();
    } catch (err) {
      setError(String(err));
    }
  };

  const remove = async () => {
    const id = selectedId();
    if (id === 'new' || !confirm('Delete this persona?')) return;
    await api.deletePersona(id);
    select('new');
    nav.closeDetail(); // mobile: back to the list after deleting
  };

  const uploadAvatar = async (file: File | undefined) => {
    const id = selectedId();
    if (!file || id === 'new') return;
    try {
      await api.uploadPersonaAvatar(id, file);
      flashSaved();
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <div class="master-detail" classList={{ 'detail-open': nav.detailOpen() }}>
      <div class="entity-list">
        <button classList={{ active: selectedId() === 'new' }} onClick={() => select('new')}>+ New persona</button>
        <For each={state.personas}>
          {(persona) => (
            <button classList={{ active: selectedId() === persona.id }} onClick={() => select(persona.id)}>
              <Avatar src={persona.avatar} name={persona.name} /> {persona.name}
            </button>
          )}
        </For>
      </div>
      <div class="form">
        <button class="detail-back" onClick={nav.closeDetail}>‹ Back to list</button>
        <Show when={selectedId() !== 'new'}>
          <div class="avatar-row">
            <Avatar src={selected()?.avatar} name={selected()?.name ?? '?'} />
            <button onClick={() => avatarInput.click()}>Change avatar</button>
            <input
              ref={avatarInput}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              hidden
              onChange={(e) => void uploadAvatar(e.currentTarget.files?.[0])}
            />
          </div>
        </Show>
        <label>Name (used as {'{{user}}'})</label>
        <input ref={nameEl} placeholder="Your name" />
        <label>Description (injected into the prompt) <MacroHelp /></label>
        <textarea
          ref={descriptionEl}
          rows="6"
          placeholder="A few sentences about {{user}} (optional)"
        />
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
