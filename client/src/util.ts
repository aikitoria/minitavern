import { createSignal } from 'solid-js';

/** Mobile master-detail paging: list page ⇄ detail page (desktop shows both, ignores this). */
export function createDetailNav() {
  const [detailOpen, setDetailOpen] = createSignal(false);
  return {
    detailOpen,
    openDetail: () => setDetailOpen(true),
    closeDetail: () => setDetailOpen(false),
  };
}

/** Transient "✓ Saved" indicator: returns [visible, trigger]. */
export function createSavedFlash(): [() => boolean, () => void] {
  const [on, setOn] = createSignal(false);
  let timer: number | undefined;
  return [
    on,
    () => {
      setOn(true);
      clearTimeout(timer);
      timer = window.setTimeout(() => setOn(false), 1500);
    },
  ];
}

/** Triggers a browser download of a server URL (content-disposition attachment). */
export function download(url: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.append(a);
  a.click();
  a.remove();
}
