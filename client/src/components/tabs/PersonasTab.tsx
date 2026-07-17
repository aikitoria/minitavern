import { For, Show } from 'solid-js';
import { api } from '../../state/api.ts';
import { state } from '../../state/store.ts';
import { createEntityEditor, errorMessage } from '../../util.ts';
import Avatar from '../Avatar.tsx';
import MacroHelp from '../MacroHelp.tsx';

export default function PersonasTab() {
  let nameEl!: HTMLInputElement;
  let descriptionEl!: HTMLTextAreaElement;
  let avatarInput!: HTMLInputElement;

  const editor = createEntityEditor({
    items: () => state.personas,
    load: (persona) => {
      nameEl.value = persona?.name ?? '';
      descriptionEl.value = persona?.description ?? '';
    },
    data: () => ({ name: nameEl.value, description: descriptionEl.value }),
    create: api.createPersona,
    patch: api.patchPersona,
    remove: api.deletePersona,
    deletePrompt: 'Delete this persona?',
  });

  const uploadAvatar = async (file: File | undefined) => {
    const id = editor.selectedId();
    if (!file || id === 'new') return;
    try {
      await api.uploadPersonaAvatar(id, file);
      editor.flashSaved();
    } catch (err) {
      editor.setStatus(errorMessage(err));
    }
  };

  return (
    <div class="master-detail" classList={{ 'detail-open': editor.nav.detailOpen() }}>
      <div class="entity-list">
        <button
          classList={{ active: editor.selectedId() === 'new' }}
          onClick={() => editor.select('new')}
        >
          + New persona
        </button>
        <For each={state.personas}>
          {(persona) => (
            <button
              classList={{ active: editor.selectedId() === persona.id }}
              onClick={() => editor.select(persona.id)}
            >
              <Avatar src={persona.avatar} name={persona.name} /> {persona.name}
            </button>
          )}
        </For>
      </div>
      <div class="form">
        <button class="detail-back" onClick={editor.nav.closeDetail}>
          ‹ Back to list
        </button>
        <Show when={editor.selectedId() !== 'new'}>
          <div class="avatar-row">
            <Avatar src={editor.selected()?.avatar} name={editor.selected()?.name ?? '?'} />
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
        <label>
          Description (injected into the prompt) <MacroHelp />
        </label>
        <textarea
          ref={descriptionEl}
          rows="6"
          placeholder="A few sentences about {{user}} (optional)"
        />
        <div class="form-actions">
          <button class="primary-btn" onClick={() => void editor.save()}>
            {editor.selectedId() === 'new' ? 'Create' : 'Save'}
          </button>
          <button onClick={() => editor.select(editor.selectedId())}>Discard</button>
          <Show when={editor.selectedId() !== 'new'}>
            <button class="danger-btn" onClick={() => void editor.remove()}>
              Delete
            </button>
          </Show>
          <Show when={editor.saved()}>
            <span class="saved-flash">✓ Saved</span>
          </Show>
        </div>
        <Show when={editor.status()}>
          <p class="hint">{editor.status()}</p>
        </Show>
      </div>
    </div>
  );
}
