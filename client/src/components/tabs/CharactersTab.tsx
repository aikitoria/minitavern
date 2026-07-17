import { For, Show, createSignal } from 'solid-js';
import { DEFAULT_PROMPT_TEMPLATE } from '@minitavern/shared';
import { api } from '../../state/api.ts';
import { state } from '../../state/store.ts';
import { createEntityEditor, download, errorMessage } from '../../util.ts';
import Avatar from '../Avatar.tsx';
import MacroHelp from '../MacroHelp.tsx';
import MacroTextarea from '../MacroTextarea.tsx';
import Select from '../Select.tsx';
import type { SelectHandle } from '../Select.tsx';

export default function CharactersTab() {
  const [customPrompt, setCustomPrompt] = createSignal(false);
  const [customTemplate, setCustomTemplate] = createSignal(false);
  let nameEl!: HTMLInputElement;
  let personalityEl!: HTMLTextAreaElement;
  let scenarioEl!: HTMLTextAreaElement;
  let firstMessageEl!: HTMLTextAreaElement;
  let presetEl!: SelectHandle;
  let customEl!: HTMLTextAreaElement;
  let templateEl!: SelectHandle;
  let customTemplateEl!: HTMLTextAreaElement;
  let customPrologueEl!: HTMLTextAreaElement;
  let customPrefixEl!: HTMLInputElement;
  let customUsesPersonasEl!: HTMLInputElement;
  let avatarInput!: HTMLInputElement;
  let cardInput!: HTMLInputElement;

  const editor = createEntityEditor({
    items: () => state.characters,
    load: (character) => {
      nameEl.value = character?.name ?? '';
      personalityEl.value = character?.personality ?? '';
      scenarioEl.value = character?.scenario ?? '';
      firstMessageEl.value = character?.firstMessage ?? '';
      presetEl.value =
        character?.customPrompt != null ? 'custom' : String(character?.presetId ?? '');
      customEl.value = character?.customPrompt ?? '';
      templateEl.value =
        character?.customTemplate != null ? 'custom' : String(character?.templateId ?? '');
      customTemplateEl.value = character?.customTemplate?.content ?? '';
      customPrologueEl.value = character?.customTemplate?.userPrologue ?? '';
      customPrefixEl.checked = character?.customTemplate?.prefixNames ?? false;
      customUsesPersonasEl.checked = character?.customTemplate?.usesPersonas ?? true;
      setCustomPrompt(character?.customPrompt != null);
      setCustomTemplate(character?.customTemplate != null);
    },
    data: () => {
      const promptChoice = presetEl.value;
      const templateChoice = templateEl.value;
      return {
        name: nameEl.value,
        personality: personalityEl.value,
        scenario: scenarioEl.value,
        firstMessage: firstMessageEl.value,
        presetId: promptChoice && promptChoice !== 'custom' ? Number(promptChoice) : null,
        customPrompt: promptChoice === 'custom' ? customEl.value : null,
        templateId: templateChoice && templateChoice !== 'custom' ? Number(templateChoice) : null,
        customTemplate:
          templateChoice === 'custom'
            ? {
                content: customTemplateEl.value,
                userPrologue: customPrologueEl.value,
                prefixNames: customPrefixEl.checked,
                usesPersonas: customUsesPersonasEl.checked,
              }
            : null,
      };
    },
    create: api.createCharacter,
    patch: api.patchCharacter,
    remove: api.deleteCharacter,
    deletePrompt: 'Delete this character?',
  });

  const uploadAvatar = async (file: File | undefined) => {
    const id = editor.selectedId();
    if (!file || id === 'new') return;
    try {
      await api.uploadCharacterAvatar(id, file);
      editor.flashSaved();
    } catch (err) {
      editor.setStatus(errorMessage(err));
    }
  };

  const importCard = async (file: File | undefined) => {
    if (!file) return;
    editor.setStatus('Importing…');
    try {
      const character = await api.importCard(file);
      editor.setStatus(`Imported ${character.name}.`);
      // The characters list refreshes via WS invalidate; select once present.
      setTimeout(() => editor.select(character.id), 150);
    } catch (err) {
      editor.setStatus(errorMessage(err));
    }
  };

  return (
    <div class="master-detail" classList={{ 'detail-open': editor.nav.detailOpen() }}>
      <div class="entity-list">
        <div class="entity-list-actions">
          <button
            classList={{ active: editor.selectedId() === 'new' }}
            onClick={() => editor.select('new')}
          >
            + New
          </button>
          <button onClick={() => cardInput.click()}>⇪ Import PNG</button>
        </div>
        <input
          ref={cardInput}
          type="file"
          accept=".png,image/png"
          hidden
          onChange={(e) => void importCard(e.currentTarget.files?.[0])}
        />
        <For each={state.characters}>
          {(character) => (
            <button
              classList={{ active: editor.selectedId() === character.id }}
              onClick={() => editor.select(character.id)}
            >
              <Avatar src={character.avatar} name={character.name} /> {character.name}
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

        <label>Name</label>
        <input ref={nameEl} placeholder="Character name" />
        <label>
          Personality <MacroHelp />
        </label>
        <MacroTextarea ref={personalityEl} placeholder="Who is {{char}}?" />
        <label>
          Scenario <MacroHelp />
        </label>
        <MacroTextarea ref={scenarioEl} placeholder="Setting / situation (optional)" />
        <label>
          First message <MacroHelp />
        </label>
        <MacroTextarea
          ref={firstMessageEl}

          placeholder="Greeting sent when a chat starts (optional)"
        />

        <label>System prompt</label>
        <Select
          ref={presetEl}
          onChange={(value) => setCustomPrompt(value === 'custom')}
          options={[
            { value: '', label: 'Global default' },
            ...state.presets.map((p) => ({ value: String(p.id), label: p.name })),
            { value: 'custom', label: 'Custom prompt…' },
          ]}
        />
        <Show when={customPrompt()}>
          <label>
            Custom prompt text <MacroHelp />
          </label>
        </Show>
        <MacroTextarea
          ref={customEl}

          classList={{ hidden: !customPrompt() }}
          placeholder="Custom system prompt for this character"
        />

        <label>Prompt template</label>
        <Select
          ref={templateEl}
          onChange={(value) => {
            const custom = value === 'custom';
            setCustomTemplate(custom);
            // Start from the built-in template rather than a blank page.
            if (custom && !customTemplateEl.value) customTemplateEl.value = DEFAULT_PROMPT_TEMPLATE;
          }}
          options={[
            { value: '', label: 'Global default' },
            ...state.templates.map((t) => ({ value: String(t.id), label: t.name })),
            { value: 'custom', label: 'Custom template…' },
          ]}
        />
        <Show when={customTemplate()}>
          <label>
            Custom template — system prompt <MacroHelp template />
          </label>
        </Show>
        <MacroTextarea
          ref={customTemplateEl}
          template
          class="mono"

          classList={{ hidden: !customTemplate() }}
        />
        <Show when={customTemplate()}>
          <label>
            First user message (optional — sent as a fake user turn before the history){' '}
            <MacroHelp template />
          </label>
        </Show>
        <MacroTextarea
          ref={customPrologueEl}
          template
          class="mono"

          classList={{ hidden: !customTemplate() }}
          placeholder="Leave empty to send no fake user message"
        />
        <label class="check-row" classList={{ hidden: !customTemplate() }}>
          <input ref={customPrefixEl} type="checkbox" />
          Prefix speaker names into messages ("{'{{user}}'}: …", "{'{{char}}'}: …") and prefill the
          reply with the current speaker name (see /char)
        </label>
        <label class="check-row" classList={{ hidden: !customTemplate() }}>
          <input ref={customUsesPersonasEl} type="checkbox" />
          Uses personas — when off, chats with this character ignore the persona entirely ("
          {'{{user}}'}" becomes "User", the persona description is not sent)
        </label>

        <div class="form-actions">
          <button class="primary-btn" onClick={() => void editor.save()}>
            {editor.selectedId() === 'new' ? 'Create' : 'Save'}
          </button>
          <button onClick={() => editor.select(editor.selectedId())}>Discard</button>
          <Show when={editor.selectedId() !== 'new'}>
            <button onClick={() => download(`/api/characters/${editor.selectedId()}/card`)}>
              Export PNG
            </button>
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
