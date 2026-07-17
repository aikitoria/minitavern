import { createSignal } from 'solid-js';

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

  const selected = () => options.items().find((item) => item.id === selectedId());
  const select = (id: EditorId) => {
    nav.openDetail();
    setSelectedId(id);
    setStatus('');
    options.load(options.items().find((item) => item.id === id));
  };
  const save = async () => {
    try {
      const id = selectedId();
      const item =
        id === 'new'
          ? await options.create(options.data())
          : await options.patch(id, options.data());
      setSelectedId(item.id);
      setStatus('');
      flashSaved();
    } catch (err) {
      setStatus(errorMessage(err));
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

  return {
    selectedId,
    saved,
    status,
    setStatus,
    nav,
    selected,
    select,
    save,
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
