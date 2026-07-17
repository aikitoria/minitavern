import { For, Show, createSignal } from 'solid-js';
import { api } from '../../state/api.ts';
import { state } from '../../state/store.ts';
import { createEntityEditor, download, errorMessage } from '../../util.ts';
import Avatar from '../Avatar.tsx';
import MacroHelp from '../MacroHelp.tsx';

export default function CharactersTab() {
  const [customPrompt, setCustomPrompt] = createSignal(false);
  let nameEl!: HTMLInputElement;
  let personalityEl!: HTMLTextAreaElement;
  let scenarioEl!: HTMLTextAreaElement;
  let firstMessageEl!: HTMLTextAreaElement;
  let presetEl!: HTMLSelectElement;
  let customEl!: HTMLTextAreaElement;
  let templateEl!: HTMLSelectElement;
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
      templateEl.value = String(character?.templateId ?? '');
      setCustomPrompt(character?.customPrompt != null);
    },
    data: () => {
      const promptChoice = presetEl.value;
      return {
        name: nameEl.value,
        personality: personalityEl.value,
        scenario: scenarioEl.value,
        firstMessage: firstMessageEl.value,
        presetId: promptChoice && promptChoice !== 'custom' ? Number(promptChoice) : null,
        customPrompt: promptChoice === 'custom' ? customEl.value : null,
        templateId: templateEl.value ? Number(templateEl.value) : null,
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
        <textarea ref={personalityEl} rows="5" placeholder="Who is {{char}}?" />
        <label>
          Scenario <MacroHelp />
        </label>
        <textarea ref={scenarioEl} rows="3" placeholder="Setting / situation (optional)" />
        <label>
          First message <MacroHelp />
        </label>
        <textarea
          ref={firstMessageEl}
          rows="3"
          placeholder="Greeting sent when a chat starts (optional)"
        />

        <label>System prompt</label>
        <select
          ref={presetEl}
          onChange={(e) => setCustomPrompt(e.currentTarget.value === 'custom')}
        >
          <option value="">Global default</option>
          <For each={state.presets}>{(p) => <option value={p.id}>Preset: {p.name}</option>}</For>
          <option value="custom">Custom prompt…</option>
        </select>
        <Show when={customPrompt()}>
          <label>
            Custom prompt text <MacroHelp />
          </label>
        </Show>
        <textarea
          ref={customEl}
          rows="6"
          classList={{ hidden: !customPrompt() }}
          placeholder="Custom system prompt for this character"
        />

        <label>Prompt template</label>
        <select ref={templateEl}>
          <option value="">Global default</option>
          <For each={state.templates}>{(t) => <option value={t.id}>{t.name}</option>}</For>
        </select>

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
