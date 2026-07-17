import { For, createSignal } from 'solid-js';
import type { Component } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import Modal from './Modal.tsx';
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
  const activeTab = () => TABS.find((item) => item.key === tab()) ?? TABS[0]!;

  return (
    <Modal
      title="Settings"
      headerExtra={
        <div class="tabs">
          <For each={TABS}>
            {(t) => (
              <button
                class="tab"
                classList={{ active: tab() === t.key }}
                onClick={() => setTab(t.key)}
              >
                {t.label}
              </button>
            )}
          </For>
        </div>
      }
    >
      <Dynamic component={activeTab().component} />
    </Modal>
  );
}
