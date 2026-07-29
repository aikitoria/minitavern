import { For, Show, createSignal } from 'solid-js';
import type { Component } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { openModal } from '../state/store.ts';
import Modal from './Modal.tsx';
import { SettingsGuardProvider } from './SettingsGuard.tsx';
import type { SettingsSectionActions } from './SettingsGuard.tsx';
import GeneralTab from './tabs/GeneralTab.tsx';
import EndpointsTab from './tabs/EndpointsTab.tsx';
import PresetsTab from './tabs/PresetsTab.tsx';
import TemplatesTab from './tabs/TemplatesTab.tsx';
import CharactersTab from './tabs/CharactersTab.tsx';
import PersonasTab from './tabs/PersonasTab.tsx';
import ToolsTab from './tabs/ToolsTab.tsx';

const TABS: { key: string; label: string; component: Component }[] = [
  { key: 'general', label: 'General', component: GeneralTab },
  { key: 'endpoints', label: 'Endpoints', component: EndpointsTab },
  { key: 'presets', label: 'Prompts', component: PresetsTab },
  { key: 'templates', label: 'Templates', component: TemplatesTab },
  { key: 'characters', label: 'Characters', component: CharactersTab },
  { key: 'personas', label: 'Personas', component: PersonasTab },
  { key: 'tools', label: 'Tools', component: ToolsTab },
];

export default function SettingsModal() {
  const [tab, setTab] = createSignal('general');
  const [promptOpen, setPromptOpen] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const activeTab = () => TABS.find((item) => item.key === tab()) ?? TABS[0]!;
  let activeActions: SettingsSectionActions | undefined;
  let pendingNavigation: (() => void) | undefined;

  const register = (actions: SettingsSectionActions) => {
    activeActions = actions;
    return () => {
      if (activeActions === actions) activeActions = undefined;
    };
  };

  const navigate = (action: () => void) => {
    if (!activeActions?.isDirty()) {
      action();
      return;
    }
    pendingNavigation = action;
    setPromptOpen(true);
  };

  const finishNavigation = () => {
    const action = pendingNavigation;
    pendingNavigation = undefined;
    setPromptOpen(false);
    action?.();
  };

  const saveAndContinue = async () => {
    if (!activeActions || saving()) return;
    setSaving(true);
    const saved = await activeActions.save();
    setSaving(false);
    if (saved) finishNavigation();
    else cancelNavigation();
  };

  const discardAndContinue = () => {
    activeActions?.discard();
    finishNavigation();
  };

  const cancelNavigation = () => {
    pendingNavigation = undefined;
    setPromptOpen(false);
  };

  return (
    <>
      <Modal
        title="Settings"
        class="settings-modal"
        onClose={() => navigate(() => openModal(null))}
        headerExtra={
          <div class="tabs" role="tablist" aria-label="Settings sections">
            <For each={TABS}>
              {(t) => (
                <button
                  class="tab"
                  classList={{ active: tab() === t.key }}
                  role="tab"
                  aria-selected={tab() === t.key}
                  onClick={() => {
                    if (t.key !== tab()) navigate(() => setTab(t.key));
                  }}
                >
                  {t.label}
                </button>
              )}
            </For>
          </div>
        }
      >
        <SettingsGuardProvider register={register} navigate={navigate}>
          <Dynamic component={activeTab().component} />
        </SettingsGuardProvider>
      </Modal>
      <Show when={promptOpen()}>
        <div class="modal-backdrop settings-prompt-backdrop">
          <div
            class="settings-prompt"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-prompt-title"
          >
            <span class="modal-title" id="settings-prompt-title">
              Save changes?
            </span>
            <p>You have unsaved changes. Save them before leaving this settings page?</p>
            <div class="form-actions">
              <button
                class="primary-btn"
                disabled={saving()}
                onClick={() => void saveAndContinue()}
              >
                {saving() ? 'Saving…' : 'Save'}
              </button>
              <button disabled={saving()} onClick={discardAndContinue}>
                Discard
              </button>
              <button disabled={saving()} onClick={cancelNavigation}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      </Show>
    </>
  );
}
