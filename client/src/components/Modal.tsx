import type { JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import { openModal } from '../state/store.ts';

export default function Modal(props: { title: string; headerExtra?: JSX.Element; children: JSX.Element }) {
  return (
    <Portal>
      <div class="modal-backdrop" onClick={() => openModal(null)}>
        <div class="modal" onClick={(e) => e.stopPropagation()}>
          <div class="modal-head">
            <span class="modal-title">{props.title}</span>
            {props.headerExtra}
            <button class="icon-btn" onClick={() => openModal(null)}>✕</button>
          </div>
          <div class="modal-body">{props.children}</div>
        </div>
      </div>
    </Portal>
  );
}
