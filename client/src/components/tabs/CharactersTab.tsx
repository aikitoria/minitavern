import { For, Show, createSignal } from 'solid-js';
import { api } from '../../state/api.ts';
import { state } from '../../state/store.ts';
import { createSavedFlash, createDetailNav, download } from '../../util.ts';
import Avatar from '../Avatar.tsx';
import MacroHelp from '../MacroHelp.tsx';

export default function CharactersTab() {
  const [selectedId, setSelectedId] = createSignal<number | 'new'>('new');
  const [customPrompt, setCustomPrompt] = createSignal(false);
  const [saved, flashSaved] = createSavedFlash();
  const nav = createDetailNav();
  const [status, setStatus] = createSignal('');
  let nameEl!: HTMLInputElement;
  let personalityEl!: HTMLTextAreaElement;
  let scenarioEl!: HTMLTextAreaElement;
  let firstMessageEl!: HTMLTextAreaElement;
  let presetEl!: HTMLSelectElement;
  let customEl!: HTMLTextAreaElement;
  let templateEl!: HTMLSelectElement;
  let avatarInput!: HTMLInputElement;
  let cardInput!: HTMLInputElement;

  const selected = () => state.characters.find((c) => c.id === selectedId());

  const select = (id: number | 'new') => {
    nav.openDetail();
    setSelectedId(id);
    setStatus('');
    const c = state.characters.find((ch) => ch.id === id);
    nameEl.value = c?.name ?? '';
    personalityEl.value = c?.personality ?? '';
    scenarioEl.value = c?.scenario ?? '';
    firstMessageEl.value = c?.firstMessage ?? '';
    presetEl.value = c?.customPrompt != null ? 'custom' : String(c?.presetId ?? '');
    customEl.value = c?.customPrompt ?? '';
    templateEl.value = String(c?.templateId ?? '');
    setCustomPrompt(c?.customPrompt != null);
  };

  const data = () => {
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
  };

  const save = async () => {
    try {
      const id = selectedId();
      const saved =
        id === 'new' ? await api.createCharacter(data()) : await api.patchCharacter(id, data());
      setSelectedId(saved.id);
      setStatus('');
      flashSaved();
    } catch (err) {
      setStatus(String(err));
    }
  };

  const remove = async () => {
    const id = selectedId();
    if (id === 'new' || !confirm('Delete this character?')) return;
    await api.deleteCharacter(id);
    select('new');
    nav.closeDetail(); // mobile: back to the list after deleting
  };

  const uploadAvatar = async (file: File | undefined) => {
    const id = selectedId();
    if (!file || id === 'new') return;
    try {
      await api.uploadCharacterAvatar(id, file);
      flashSaved();
    } catch (err) {
      setStatus(String(err));
    }
  };

  const importCard = async (file: File | undefined) => {
    if (!file) return;
    setStatus('Importing…');
    try {
      const character = await api.importCard(file);
      setStatus(`Imported ${character.name}.`);
      // The characters list refreshes via WS invalidate; select once present.
      setTimeout(() => select(character.id), 150);
    } catch (err) {
      setStatus(String(err));
    }
  };

  return (
    <div class="master-detail" classList={{ 'detail-open': nav.detailOpen() }}>
      <div class="entity-list">
        <div class="entity-list-actions">
          <button classList={{ active: selectedId() === 'new' }} onClick={() => select('new')}>
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
              classList={{ active: selectedId() === character.id }}
              onClick={() => select(character.id)}
            >
              <Avatar src={character.avatar} name={character.name} /> {character.name}
            </button>
          )}
        </For>
      </div>
      <div class="form">
        <button class="detail-back" onClick={nav.closeDetail}>
          ‹ Back to list
        </button>
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
          <button class="primary-btn" onClick={() => void save()}>
            {selectedId() === 'new' ? 'Create' : 'Save'}
          </button>
          <button onClick={() => select(selectedId())}>Discard</button>
          <Show when={selectedId() !== 'new'}>
            <button onClick={() => download(`/api/characters/${selectedId()}/card`)}>
              Export PNG
            </button>
            <button class="danger-btn" onClick={() => void remove()}>
              Delete
            </button>
          </Show>
          <Show when={saved()}>
            <span class="saved-flash">✓ Saved</span>
          </Show>
        </div>
        <Show when={status()}>
          <p class="hint">{status()}</p>
        </Show>
      </div>
    </div>
  );
}
