import { For, Show, createSignal } from 'solid-js';
import { DEFAULT_PROMPT_TEMPLATE } from '@minitavern/shared';
import { api } from '../../state/api.ts';
import { state } from '../../state/store.ts';
import { createSavedFlash, createDetailNav } from '../../util.ts';
import MacroHelp from '../MacroHelp.tsx';

export default function TemplatesTab() {
  const [selectedId, setSelectedId] = createSignal<number | 'new'>('new');
  const [saved, flashSaved] = createSavedFlash();
  const nav = createDetailNav();
  const [error, setError] = createSignal('');
  let nameEl!: HTMLInputElement;
  let contentEl!: HTMLTextAreaElement;
  let prologueEl!: HTMLTextAreaElement;
  let prefixEl!: HTMLInputElement;

  const select = (id: number | 'new') => {
    nav.openDetail();
    setSelectedId(id);
    setError('');
    const template = state.templates.find((t) => t.id === id);
    nameEl.value = template?.name ?? '';
    contentEl.value = template?.content ?? DEFAULT_PROMPT_TEMPLATE;
    prologueEl.value = template?.userPrologue ?? '';
    prefixEl.checked = template?.prefixNames ?? false;
  };

  const data = () => ({
    name: nameEl.value,
    content: contentEl.value,
    userPrologue: prologueEl.value,
    prefixNames: prefixEl.checked,
  });

  const save = async () => {
    try {
      const id = selectedId();
      const saved =
        id === 'new' ? await api.createTemplate(data()) : await api.patchTemplate(id, data());
      setSelectedId(saved.id);
      setError('');
      flashSaved();
    } catch (err) {
      setError(String(err));
    }
  };

  const remove = async () => {
    const id = selectedId();
    if (id === 'new' || !confirm('Delete this template?')) return;
    await api.deleteTemplate(id);
    select('new');
    nav.closeDetail(); // mobile: back to the list after deleting
  };

  return (
    <div class="master-detail" classList={{ 'detail-open': nav.detailOpen() }}>
      <div class="entity-list">
        <button classList={{ active: selectedId() === 'new' }} onClick={() => select('new')}>
          + New template
        </button>
        <For each={state.templates}>
          {(template) => (
            <button
              classList={{ active: selectedId() === template.id }}
              onClick={() => select(template.id)}
            >
              {template.name}
            </button>
          )}
        </For>
      </div>
      <div class="form">
        <button class="detail-back" onClick={nav.closeDetail}>
          ‹ Back to list
        </button>
        <label>Name</label>
        <input ref={nameEl} placeholder="Roleplay" />
        <label>
          System prompt template <MacroHelp template />
        </label>
        <textarea ref={contentEl} class="mono" rows="9" />
        <label>
          First user message (optional — sent as a fake user turn before the history){' '}
          <MacroHelp template />
        </label>
        <textarea
          ref={prologueEl}
          class="mono"
          rows="5"
          placeholder="Leave empty to send no fake user message"
        />
        <label class="check-row">
          <input ref={prefixEl} type="checkbox" />
          Prefix speaker names into messages ("{'{{user}}'}: …", "{'{{char}}'}: …") and prefill the
          reply with the current speaker name (see /char)
        </label>
        <div class="form-actions">
          <button class="primary-btn" onClick={() => void save()}>
            {selectedId() === 'new' ? 'Create' : 'Save'}
          </button>
          <button onClick={() => select(selectedId())}>Discard</button>
          <Show when={selectedId() !== 'new'}>
            <button class="danger-btn" onClick={() => void remove()}>
              Delete
            </button>
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
