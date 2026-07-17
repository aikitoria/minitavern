import { Show, createEffect, createSignal, untrack } from 'solid-js';
import Select from '../Select.tsx';
import { createStore, reconcile } from 'solid-js/store';
import type { Settings } from '@minitavern/shared';
import { api, ApiError } from '../../state/api.ts';
import { setState, state } from '../../state/store.ts';
import { createSavedFlash, errorMessage, numberOrNull } from '../../util.ts';

function snapshot(): Settings {
  return { ...state.settings };
}

type SettingKey = Exclude<keyof Settings, 'revision'>;
const SETTING_KEYS: SettingKey[] = [
  'activeEndpointId',
  'defaultPresetId',
  'defaultPersonaId',
  'defaultTemplateId',
  'autoExpandThinking',
  'backgroundSwipeGeneration',
];

export default function GeneralTab() {
  const [draft, setDraft] = createStore<Settings>(snapshot());
  const [dirty, setDirty] = createStore<Record<SettingKey, boolean>>(
    Object.fromEntries(SETTING_KEYS.map((key) => [key, false])) as Record<SettingKey, boolean>,
  );
  const [baseRevision, setBaseRevision] = createSignal(state.settings.revision);
  const [saved, flashSaved] = createSavedFlash();
  const [error, setError] = createSignal('');

  const isDirty = () => SETTING_KEYS.some((key) => dirty[key]);
  const change = <K extends SettingKey>(key: K, value: Settings[K]) => {
    setDraft(key, value);
    setDirty(key, true);
  };

  createEffect(() => {
    const latest = snapshot();
    if (latest.revision === draft.revision) return;
    const preserved = untrack(() =>
      Object.fromEntries(SETTING_KEYS.filter((key) => dirty[key]).map((key) => [key, draft[key]])),
    );
    setDraft(reconcile({ ...latest, ...preserved }));
    if (!untrack(isDirty)) setBaseRevision(latest.revision);
  });

  const save = async () => {
    try {
      const patch = Object.fromEntries(
        SETTING_KEYS.filter((key) => dirty[key]).map((key) => [key, draft[key]]),
      ) as Partial<Settings>;
      if (!isDirty()) return;
      const next = await api.putSettings(patch, baseRevision());
      setState('settings', next);
      setDraft(reconcile(next));
      for (const key of SETTING_KEYS) setDirty(key, false);
      setBaseRevision(next.revision);
      setError('');
      flashSaved();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        try {
          const latest = await api.settings();
          const preserved = Object.fromEntries(
            SETTING_KEYS.filter((key) => dirty[key]).map((key) => [key, draft[key]]),
          );
          setState('settings', latest);
          setDraft(reconcile({ ...latest, ...preserved }));
          setBaseRevision(latest.revision);
        } catch {
          /* Keep the original conflict visible if the refresh also fails. */
        }
      }
      setError(errorMessage(err));
    }
  };

  const discard = () => {
    setDraft(reconcile(snapshot()));
    for (const key of SETTING_KEYS) setDirty(key, false);
    setBaseRevision(state.settings.revision);
    setError('');
  };

  return (
    <div class="form">
      <label>Active endpoint (all generations go through this)</label>
      <Select
        value={draft.activeEndpointId?.toString() ?? ''}
        onChange={(v) => change('activeEndpointId', numberOrNull(v))}
        options={[
          { value: '', label: '— none —' },
          ...state.endpoints.map((ep) => ({ value: String(ep.id), label: ep.name })),
        ]}
      />
      <p class="hint">
        Model and sampling settings are configured per endpoint in the Endpoints tab.
      </p>

      <label>Default system prompt preset</label>
      <Select
        value={draft.defaultPresetId?.toString() ?? ''}
        onChange={(v) => change('defaultPresetId', numberOrNull(v))}
        options={[
          { value: '', label: '— none —' },
          ...state.presets.map((p) => ({ value: String(p.id), label: p.name })),
        ]}
      />

      <label>Default persona</label>
      <Select
        value={draft.defaultPersonaId?.toString() ?? ''}
        onChange={(v) => change('defaultPersonaId', numberOrNull(v))}
        options={[
          { value: '', label: '— none —' },
          ...state.personas.map((p) => ({ value: String(p.id), label: p.name })),
        ]}
      />

      <label>Default prompt template</label>
      <Select
        value={draft.defaultTemplateId?.toString() ?? ''}
        onChange={(v) => change('defaultTemplateId', numberOrNull(v))}
        options={[
          { value: '', label: '— built-in default —' },
          ...state.templates.map((t) => ({ value: String(t.id), label: t.name })),
        ]}
      />

      <label class="check-row">
        <input
          type="checkbox"
          checked={draft.autoExpandThinking}
          onChange={(e) => change('autoExpandThinking', e.currentTarget.checked)}
        />
        Auto-expand thinking while the model reasons (collapses once the reply starts)
      </label>

      <label class="check-row">
        <input
          type="checkbox"
          checked={draft.backgroundSwipeGeneration}
          onChange={(e) => change('backgroundSwipeGeneration', e.currentTarget.checked)}
        />
        Background Swipe Generation (keep one unread assistant swipe prepared ahead)
      </label>

      <div class="form-actions">
        <button class="primary-btn" onClick={() => void save()}>
          Save
        </button>
        <button onClick={discard}>Discard</button>
        <Show when={saved()}>
          <span class="saved-flash">✓ Saved</span>
        </Show>
      </div>
      <Show when={error()}>
        <p class="hint">{error()}</p>
      </Show>
    </div>
  );
}
