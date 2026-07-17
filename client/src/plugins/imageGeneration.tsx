import { Show, createSignal, onMount } from 'solid-js';
import type { Plugin } from './api.ts';
import { pluginSettings, savePluginSettings } from './api.ts';
import { api } from '../state/api.ts';
import { navigateTree, state, toast } from '../state/store.ts';
import { createSavedFlash, errorMessage } from '../util.ts';
import MacroHelp from '../components/MacroHelp.tsx';
import MacroTextarea from '../components/MacroTextarea.tsx';

const ID = 'imageGeneration';

interface ImageGenSettings extends Record<string, unknown> {
  /** Asks the model to describe the character/scene as an image prompt. */
  describePrompt: string;
  /** Used by /image <instruction>; {{instruction}} expands to the argument. */
  instructionPrompt: string;
}

const DEFAULTS: ImageGenSettings = {
  describePrompt:
    "Describe {{char}}'s current appearance and surroundings as a single detailed image-generation prompt. Reply with only the prompt.",
  instructionPrompt: '{{instruction}}',
};

const settings = () => pluginSettings(ID, DEFAULTS);

/** No instruction → the describe-character prompt; otherwise the instruction
 * prompt with {{instruction}} expanded (empty template = the raw instruction).
 * {{char}}/{{user}} expand server-side, where the conversation context lives. */
function composePrompt(instruction: string): string {
  if (!instruction) return settings().describePrompt;
  const template = settings().instructionPrompt.trim() || '{{instruction}}';
  // Callback replacement: a string would interpret $-sequences in the
  // user's instruction ("$$99" → "$99", "$&" → the matched macro).
  return template.replaceAll(/\{\{instruction\}\}/gi, () => instruction);
}

/** Streams the image description into a tool message as a foreground generation. */
async function generate(instruction: string): Promise<boolean> {
  if (state.selectedId == null) {
    toast('No conversation selected.');
    return false;
  }
  return navigateTree(() =>
    api.toolGenerate(
      state.selectedId!,
      composePrompt(instruction),
      'Image prompt',
      state.tree.activeLeafId,
    ),
  );
}

const ImageIcon = () => (
  <svg
    viewBox="0 0 24 24"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="M21 16l-5-5-9 9" />
  </svg>
);

function SettingsPage() {
  let describeEl!: HTMLTextAreaElement;
  let instructionEl!: HTMLTextAreaElement;
  const [saved, flashSaved] = createSavedFlash();
  const [error, setError] = createSignal('');

  const load = () => {
    describeEl.value = settings().describePrompt;
    instructionEl.value = settings().instructionPrompt;
  };
  onMount(load);

  const save = async () => {
    try {
      await savePluginSettings(ID, {
        describePrompt: describeEl.value,
        instructionPrompt: instructionEl.value,
      });
      setError('');
      flashSaved();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <>
      <label>
        Character description prompt (sent to the model to describe the scene as an image prompt){' '}
        <MacroHelp />
      </label>
      <MacroTextarea ref={describeEl} placeholder={DEFAULTS.describePrompt} />
      <label>
        Instruction prompt for /image — {'{{instruction}}'} expands to the command argument{' '}
        <MacroHelp />
      </label>
      <MacroTextarea
        ref={instructionEl}
        extraKeys={['instruction']}
        placeholder="Leave empty to use the instruction verbatim"
      />
      <div class="form-actions">
        <button class="primary-btn" onClick={() => void save()}>
          Save
        </button>
        <button
          onClick={() => {
            load();
            setError('');
          }}
        >
          Discard
        </button>
        <Show when={saved()}>
          <span class="saved-flash">✓ Saved</span>
        </Show>
      </div>
      <Show when={error()}>
        <p class="hint">{error()}</p>
      </Show>
    </>
  );
}

export const imageGenerationPlugin: Plugin = {
  id: ID,
  name: 'Image Generation',
  tools: [{ label: 'Generate image', icon: ImageIcon, run: () => void generate('') }],
  commands: [
    {
      name: 'image',
      params: '<instruction>',
      description:
        'Generate an image description; the optional instruction expands into the instruction prompt as {{instruction}}',
      // Returning navigateTree's result keeps the composer text on failure.
      run: (args) => generate(args.trim()),
    },
  ],
  settingsPage: SettingsPage,
};
