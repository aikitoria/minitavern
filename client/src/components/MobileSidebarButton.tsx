import { Show } from 'solid-js';
import { isMobileLayout, toggleSidebar } from '../state/store.ts';

/** Mobile sidebar access lives in the bottom control bar, never over chat content. */
export default function MobileSidebarButton() {
  return (
    <Show when={isMobileLayout()}>
      <button
        class="send-btn tools-btn mobile-sidebar-btn"
        title="Conversations"
        aria-label="Open conversations"
        onClick={toggleSidebar}
      >
        ☰
      </button>
    </Show>
  );
}
