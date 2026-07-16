import { Show } from 'solid-js';
import { booting, state, setState } from './state/store.ts';
import Sidebar from './components/Sidebar.tsx';
import Header from './components/Header.tsx';
import ChatView from './components/ChatView.tsx';
import Composer from './components/Composer.tsx';
import SettingsModal from './components/SettingsModal.tsx';
import ConversationSettings from './components/ConversationSettings.tsx';

export default function App() {
  return (
    <div class="app">
      <Show when={booting()}>
        <div class="boot-screen">
          <img src="/icon.svg" alt="" width="72" height="72" />
          <span class="boot-name">MiniTavern</span>
          <span class="boot-dots">
            <i />
            <i />
            <i />
          </span>
        </div>
      </Show>
      <Sidebar />
      <Show when={state.sidebarOpen}>
        <div class="backdrop" onClick={() => setState('sidebarOpen', false)} />
      </Show>
      <main class="main">
        <Header />
        <ChatView />
        <Composer />
      </main>
      <Show when={state.modal === 'settings'}>
        <SettingsModal />
      </Show>
      <Show when={state.modal === 'conversation'}>
        <ConversationSettings />
      </Show>
    </div>
  );
}
