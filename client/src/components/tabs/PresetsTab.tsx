import { For, Show } from 'solid-js';
import { api } from '../../state/api.ts';
import { state } from '../../state/store.ts';
import { createEntityEditor } from '../../util.ts';
import MacroHelp from '../MacroHelp.tsx';

export default function PresetsTab() {
  let nameEl!: HTMLInputElement;
  let contentEl!: HTMLTextAreaElement;
  const editor = createEntityEditor({
    items: () => state.presets,
    load: (preset) => {
      nameEl.value = preset?.name ?? '';
      contentEl.value = preset?.content ?? '';
    },
    data: () => ({ name: nameEl.value, content: contentEl.value }),
    create: api.createPreset,
    patch: api.patchPreset,
    remove: api.deletePreset,
    deletePrompt: 'Delete this preset?',
  });

  return (
    <div class="master-detail" classList={{ 'detail-open': editor.nav.detailOpen() }}>
      <div class="entity-list">
        <button
          classList={{ active: editor.selectedId() === 'new' }}
          onClick={() => editor.select('new')}
        >
          + New preset
        </button>
        <For each={state.presets}>
          {(preset) => (
            <button
              classList={{ active: editor.selectedId() === preset.id }}
              onClick={() => editor.select(preset.id)}
            >
              {preset.name}
            </button>
          )}
        </For>
      </div>
      <div class="form">
        <button class="detail-back" onClick={editor.nav.closeDetail}>
          ‹ Back to list
        </button>
        <label>Name</label>
        <input ref={nameEl} placeholder="Creative writer" />
        <label>
          System prompt <MacroHelp />
        </label>
        <textarea ref={contentEl} rows="10" placeholder="You are {{char}}, …" />
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
