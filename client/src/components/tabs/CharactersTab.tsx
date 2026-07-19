import { Show, createSignal } from 'solid-js';
import { DEFAULT_PROMPT_TEMPLATE, DEFAULT_STEER_TEMPLATE } from '@minitavern/shared';
import { api } from '../../state/api.ts';
import { state } from '../../state/store.ts';
import { avatarGenerationAvailable } from '../../plugins/imageGeneration.tsx';
import AvatarGenerateModal from '../../plugins/AvatarGenerateModal.tsx';
import { createEntityEditor, download, errorMessage } from '../../util.ts';
import Avatar from '../Avatar.tsx';
import AvatarRow from '../AvatarRow.tsx';
import EntityEditorPane from '../EntityEditorPane.tsx';
import MacroHelp from '../MacroHelp.tsx';
import MacroTextarea from '../MacroTextarea.tsx';
import Select from '../Select.tsx';
import type { SelectHandle } from '../Select.tsx';

export default function CharactersTab() {
  const [customPrompt, setCustomPrompt] = createSignal(false);
  const [customTemplate, setCustomTemplate] = createSignal(false);
  const [avatarGen, setAvatarGen] = createSignal(false);
  let nameEl!: HTMLInputElement;
  let personalityEl!: HTMLTextAreaElement;
  let scenarioEl!: HTMLTextAreaElement;
  let examplesEl!: HTMLTextAreaElement;
  let firstMessageEl!: HTMLTextAreaElement;
  let presetEl!: SelectHandle;
  let customEl!: HTMLTextAreaElement;
  let templateEl!: SelectHandle;
  let customTemplateEl!: HTMLTextAreaElement;
  let customPrologueEl!: HTMLTextAreaElement;
  let customPrefixEl!: HTMLInputElement;
  let customUsesPersonasEl!: HTMLInputElement;
  let customSteerEl!: HTMLTextAreaElement;
  let cardInput!: HTMLInputElement;

  const editor = createEntityEditor({
    items: () => state.characters,
    load: (character) => {
      nameEl.value = character?.name ?? '';
      personalityEl.value = character?.personality ?? '';
      scenarioEl.value = character?.scenario ?? '';
      examplesEl.value = character?.examples ?? '';
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
      customSteerEl.value = character?.customTemplate?.steerTemplate ?? DEFAULT_STEER_TEMPLATE;
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
        examples: examplesEl.value,
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
                steerTemplate: customSteerEl.value,
              }
            : null,
      };
    },
    create: api.createCharacter,
    patch: api.patchCharacter,
    remove: api.deleteCharacter,
    deletePrompt: 'Delete this character?',
  });

  const importCard = async (file: File | undefined) => {
    if (!file) return;
    editor.setStatus('Importing…');
    try {
      const character = await api.importCard(file);
      // The list refreshes via WS invalidate; load the form straight from the
      // response instead of racing that refetch.
      editor.adopt(character);
      editor.setStatus(`Imported ${character.name}.`);
    } catch (err) {
      editor.setStatus(errorMessage(err));
    }
  };

  return (
    <EntityEditorPane
      editor={editor}
      items={state.characters}
      itemLabel={(character) => (
        <>
          <Avatar src={character.avatar} name={character.name} /> {character.name}
        </>
      )}
      newLabel="+ New"
      listActions={
        <>
          <button onClick={() => cardInput.click()}>⇪ Import PNG</button>
          <input
            ref={cardInput}
            type="file"
            accept=".png,image/png"
            hidden
            onChange={(e) => void importCard(e.currentTarget.files?.[0])}
          />
        </>
      }
      extraActions={
        <button onClick={() => download(`/api/characters/${editor.selectedId()}/card`)}>
          Export PNG
        </button>
      }
    >
      <Show when={editor.selectedId() !== 'new'}>
        <AvatarRow
          src={editor.selected()?.avatar}
          name={editor.selected()?.name ?? '?'}
          upload={(file) => api.uploadCharacterAvatar(editor.selectedId() as number, file)}
          generate={
            avatarGenerationAvailable()
              ? async () => {
                  setAvatarGen(true);
                }
              : undefined
          }
          onDone={editor.flashSaved}
          onError={editor.setStatus}
        />
        <Show when={avatarGen()}>
          <AvatarGenerateModal
            kind="character"
            id={editor.selectedId() as number}
            onClose={() => setAvatarGen(false)}
          />
        </Show>
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
        Example conversations <MacroHelp />
      </label>
      <MacroTextarea
        ref={examplesEl}
        placeholder="Example dialogue between {{user}} and {{char}} (optional; separate with <START>)"
      />
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
      <Show when={customTemplate()}>
        <label>Custom template — steer template (regenerate with instruction)</label>
      </Show>
      <MacroTextarea
        ref={customSteerEl}
        keys={['instruction']}
        rows={2}
        classList={{ hidden: !customTemplate() }}
      />
      <Show when={customTemplate()}>
        <p class="hint">
          {'{{instruction}}'} is replaced with your instruction and injected into that
          regeneration's prompt only. Leave empty to use the built-in default.
        </p>
      </Show>
    </EntityEditorPane>
  );
}
