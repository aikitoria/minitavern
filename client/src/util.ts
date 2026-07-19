import { createSignal, onCleanup, onMount } from 'solid-js';
import { useSettingsGuard } from './components/SettingsGuard.tsx';

export type EditorId = number | 'new';

interface EntityEditorOptions<T extends { id: number }, D> {
  items: () => readonly T[];
  load: (item: T | undefined) => void;
  data: () => D;
  create: (data: D) => Promise<T>;
  patch: (id: number, data: D) => Promise<T>;
  remove: (id: number) => Promise<void>;
  deletePrompt: string;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Popover dismiss wiring: close on click outside `root` or on Escape.
 * Call from component setup — the document listeners live for the component's
 * lifetime and are cleaned up with it. */
export function useDismiss(
  root: () => HTMLElement | undefined,
  open: () => boolean,
  close: () => void,
): void {
  const onDocClick = (event: MouseEvent) => {
    const el = root();
    if (open() && el && !el.contains(event.target as Node)) close();
  };
  const onDocKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') close();
  };
  onMount(() => {
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onDocKey);
  });
  onCleanup(() => {
    document.removeEventListener('click', onDocClick);
    document.removeEventListener('keydown', onDocKey);
  });
}

export function numberOrNull(value: string): number | null {
  return value === '' ? null : Number(value);
}

/** Shared state/actions for the settings master-detail CRUD editors. */
export function createEntityEditor<T extends { id: number }, D>(
  options: EntityEditorOptions<T, D>,
) {
  const [selectedId, setSelectedId] = createSignal<EditorId>('new');
  const [saved, flashSaved] = createSavedFlash();
  const [status, setStatus] = createSignal('');
  const nav = createDetailNav();
  let baseline = '';

  const captureBaseline = () => {
    baseline = JSON.stringify(options.data());
  };
  const load = (item: T | undefined) => {
    options.load(item);
    captureBaseline();
  };

  const selected = () => options.items().find((item) => item.id === selectedId());
  const select = (id: EditorId) => {
    nav.openDetail();
    setSelectedId(id);
    setStatus('');
    load(options.items().find((item) => item.id === id));
  };
  /** Select-and-load an item that may not be in items() yet (e.g. a fresh
   * import whose WS invalidate refetch hasn't landed). */
  const adopt = (item: T) => {
    nav.openDetail();
    setSelectedId(item.id);
    load(item);
  };
  // Seed the initial "new entity" form once the refs exist: raw DOM defaults
  // diverge from load(undefined) (e.g. a Select with no '' option stays '').
  onMount(() => {
    if (selectedId() === 'new') load(undefined);
  });
  const save = async () => {
    try {
      const id = selectedId();
      const item =
        id === 'new'
          ? await options.create(options.data())
          : await options.patch(id, options.data());
      setSelectedId(item.id);
      setStatus('');
      // Reload the server's representation so normalized values (and secrets
      // such as an endpoint key) do not immediately look dirty after saving.
      load(item);
      flashSaved();
      return true;
    } catch (err) {
      setStatus(errorMessage(err));
      return false;
    }
  };
  const remove = async () => {
    const id = selectedId();
    if (id === 'new' || !confirm(options.deletePrompt)) return;
    try {
      await options.remove(id);
      select('new');
      nav.closeDetail();
    } catch (err) {
      setStatus(errorMessage(err));
    }
  };
  const discard = () => select(selectedId());

  useSettingsGuard({
    isDirty: () => JSON.stringify(options.data()) !== baseline,
    save,
    discard,
  });

  return {
    selectedId,
    saved,
    status,
    setStatus,
    nav,
    selected,
    select,
    adopt,
    save,
    discard,
    remove,
    flashSaved,
  };
}

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
