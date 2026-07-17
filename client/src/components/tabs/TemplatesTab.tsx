import { For, Show } from 'solid-js';
import { DEFAULT_PROMPT_TEMPLATE } from '@minitavern/shared';
import { api } from '../../state/api.ts';
import { state } from '../../state/store.ts';
import { createEntityEditor } from '../../util.ts';
import MacroHelp from '../MacroHelp.tsx';
import MacroTextarea from '../MacroTextarea.tsx';

export default function TemplatesTab() {
  let nameEl!: HTMLInputElement;
  let contentEl!: HTMLTextAreaElement;
  let prologueEl!: HTMLTextAreaElement;
  let prefixEl!: HTMLInputElement;
  let usesPersonasEl!: HTMLInputElement;

  const editor = createEntityEditor({
    items: () => state.templates,
    load: (template) => {
      nameEl.value = template?.name ?? '';
      contentEl.value = template?.content ?? DEFAULT_PROMPT_TEMPLATE;
      prologueEl.value = template?.userPrologue ?? '';
      prefixEl.checked = template?.prefixNames ?? false;
      usesPersonasEl.checked = template?.usesPersonas ?? true;
    },
    data: () => ({
      name: nameEl.value,
      content: contentEl.value,
      userPrologue: prologueEl.value,
      prefixNames: prefixEl.checked,
      usesPersonas: usesPersonasEl.checked,
    }),
    create: api.createTemplate,
    patch: api.patchTemplate,
    remove: api.deleteTemplate,
    deletePrompt: 'Delete this template?',
  });

  return (
    <div class="master-detail" classList={{ 'detail-open': editor.nav.detailOpen() }}>
      <div class="entity-list">
        <button
          classList={{ active: editor.selectedId() === 'new' }}
          onClick={() => editor.select('new')}
        >
          + New template
        </button>
        <For each={state.templates}>
          {(template) => (
            <button
              classList={{ active: editor.selectedId() === template.id }}
              onClick={() => editor.select(template.id)}
            >
              {template.name}
            </button>
          )}
        </For>
      </div>
      <div class="form">
        <button class="detail-back" onClick={editor.nav.closeDetail}>
          ‹ Back to list
        </button>
        <label>Name</label>
        <input ref={nameEl} placeholder="Roleplay" />
        <label>
          System prompt template <MacroHelp template />
        </label>
        <MacroTextarea ref={contentEl} template class="mono" />
        <label>
          First user message (optional — sent as a fake user turn before the history){' '}
          <MacroHelp template />
        </label>
        <MacroTextarea
          ref={prologueEl}
          template
          class="mono"

          placeholder="Leave empty to send no fake user message"
        />
        <label class="check-row">
          <input ref={prefixEl} type="checkbox" />
          Prefix speaker names into messages ("{'{{user}}'}: …", "{'{{char}}'}: …") and prefill the
          reply with the current speaker name (see /char)
        </label>
        <label class="check-row">
          <input ref={usesPersonasEl} type="checkbox" />
          Uses personas — when off, chats with this template ignore the persona entirely ("
          {'{{user}}'}" becomes "User", the persona description is not sent)
        </label>
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
