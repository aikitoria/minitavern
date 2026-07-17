import { For, Show, createSignal, onCleanup, onMount } from 'solid-js';

const BASIC: [string, string][] = [
  ['{{char}}', 'The character\'s name (or "Assistant")'],
  ['{{user}}', 'The persona\'s name (or "User")'],
];

const TEMPLATE: [string, string][] = [
  [
    '{{system}}',
    'Resolved system prompt: character custom → character preset → global default preset',
  ],
  ['{{personality}}', "The character's personality text"],
  ['{{persona}}', "The persona's description text"],
  ['{{scenario}}', "The character's scenario text"],
  [
    '{{#if x}}…{{/if}}',
    'Include the block only when slot x is non-empty (x = system, personality, persona, scenario)',
  ],
];

/** "?" chip that pops a reference card of the macros usable in the adjacent field. */
export default function MacroHelp(props: { template?: boolean }) {
  const [open, setOpen] = createSignal(false);
  let root: HTMLSpanElement | undefined;

  const onDocClick = (event: MouseEvent) => {
    if (open() && root && !root.contains(event.target as Node)) setOpen(false);
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') setOpen(false);
  };

  onMount(() => {
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onKey);
  });
  onCleanup(() => {
    document.removeEventListener('click', onDocClick);
    document.removeEventListener('keydown', onKey);
  });

  // Basics first, then content slots in built-in template order, syntax last.
  const rows = () => (props.template ? [...BASIC, ...TEMPLATE] : BASIC);

  return (
    <span class="macro-help" ref={root}>
      <button class="help-btn" title="Available macros" onClick={() => setOpen(!open())}>
        ?
      </button>
      <Show when={open()}>
        <div class="help-card">
          <div class="help-title">Available macros</div>
          <For each={rows()}>
            {([macro, description]) => (
              <div class="help-row">
                <code>{macro}</code>
                <span>{description}</span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </span>
  );
}
