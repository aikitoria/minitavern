import { Show, createSignal, onMount } from 'solid-js';
import type { Plugin, PluginMessageView } from './api.ts';
import { pluginSettings, savePluginSettings } from './api.ts';
import { api } from '../state/api.ts';
import { imageProgress, navigateTree, state, toast } from '../state/store.ts';
import { createSavedFlash, errorMessage } from '../util.ts';
import ImageViewer from '../components/ImageViewer.tsx';
import MacroHelp from '../components/MacroHelp.tsx';
import MacroTextarea from '../components/MacroTextarea.tsx';
import Markdown from '../components/Markdown.tsx';
import Select from '../components/Select.tsx';
import type { SelectHandle } from '../components/Select.tsx';
import './imageGeneration.css';

const ID = 'imageGeneration';

interface ImageWorkflow {
  name: string;
  /** ComfyUI workflow (API format JSON) with {{prompt}}/{{seed}} slots. */
  json: string;
}

interface ImageGenSettings extends Record<string, unknown> {
  /** Asks the model to describe the character/scene as an image prompt. */
  describePrompt: string;
  /** Used by /image <instruction>; {{instruction}} expands to the argument. */
  instructionPrompt: string;
  comfyUrl: string;
  workflows: ImageWorkflow[];
  /** Name of the workflow /image renders with; '' = describe only, no image. */
  activeWorkflow: string;
}

const DEFAULTS: ImageGenSettings = {
  describePrompt:
    "Describe {{char}}'s current appearance and surroundings as a single detailed image-generation prompt. Reply with only the prompt.",
  instructionPrompt: '{{instruction}}',
  comfyUrl: 'http://comfy:8588',
  workflows: [],
  activeWorkflow: '',
};

const WORKFLOW_MACROS: [string, string][] = [
  ['{{prompt}}', 'The generated image description (JSON-string-escaped into the workflow)'],
  ['{{seed}}', 'A random integer seed, fresh per render'],
];

function settings(): ImageGenSettings {
  const cfg = pluginSettings(ID, DEFAULTS);
  // Migrate the pre-multi-workflow shape (single workflowJson string).
  const legacy = (cfg as Record<string, unknown>).workflowJson;
  if (cfg.workflows.length === 0 && typeof legacy === 'string' && legacy.trim()) {
    return {
      ...cfg,
      workflows: [{ name: 'Default', json: legacy }],
      activeWorkflow: 'Default',
    };
  }
  return cfg;
}

/** Mirror of the server's route-time check so a broken paste fails at save time. */
function workflowError(workflow: string): string | null {
  if (!workflow.trim()) return null;
  const dummy = workflow
    .replaceAll(/\{\{prompt\}\}/gi, () => 'test')
    .replaceAll(/\{\{seed\}\}/gi, () => '1');
  try {
    const parsed: unknown = JSON.parse(dummy);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? null
      : 'must be a JSON object (ComfyUI API format)';
  } catch (err) {
    return `is not valid JSON after macro substitution: ${errorMessage(err)}`;
  }
}

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

/** The active workflow as a render config; undefined when none is configured. */
function activeRenderConfig(): { workflow: string; comfyUrl: string } | undefined {
  const cfg = settings();
  const active = cfg.workflows.find((workflow) => workflow.name === cfg.activeWorkflow);
  return active?.json.trim() ? { workflow: active.json, comfyUrl: cfg.comfyUrl } : undefined;
}

/** Streams the image description into a tool message as a foreground
 * generation; with an active workflow, ComfyUI then renders the image. */
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
      activeRenderConfig(),
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
  let comfyUrlEl!: HTMLInputElement;
  let nameEl!: HTMLInputElement;
  let workflowEl!: HTMLTextAreaElement;
  let pickerEl!: SelectHandle;
  const [saved, flashSaved] = createSavedFlash();
  const [error, setError] = createSignal('');
  const [workflows, setWorkflows] = createSignal<ImageWorkflow[]>([]);
  /** Index into workflows(); -1 = none (describe only). Selected = active for /image. */
  const [selected, setSelected] = createSignal(-1);
  const [workflowText, setWorkflowText] = createSignal('');

  /** Read the editable fields back into the workflows list before switching/saving. */
  const stash = () => {
    const idx = selected();
    if (idx === -1) return;
    setWorkflows((list) =>
      list.map((workflow, i) =>
        i === idx
          ? { name: nameEl.value.trim() || workflow.name, json: workflowEl.value }
          : workflow,
      ),
    );
  };

  const showWorkflow = (idx: number) => {
    setSelected(idx);
    pickerEl.value = String(idx);
    const workflow = workflows()[idx];
    nameEl.value = workflow?.name ?? '';
    workflowEl.value = workflow?.json ?? '';
  };

  const pick = (idx: number) => {
    stash();
    showWorkflow(idx);
  };

  const addWorkflow = () => {
    stash();
    setWorkflows((list) => {
      // Names are the workflow identity (activeWorkflow refers to one) — never
      // generate a name that's already taken.
      let n = list.length + 1;
      while (list.some((workflow) => workflow.name === `Workflow ${n}`)) n++;
      return [...list, { name: `Workflow ${n}`, json: '' }];
    });
    showWorkflow(workflows().length - 1);
  };

  const deleteWorkflow = () => {
    const idx = selected();
    if (idx === -1) return;
    setWorkflows((list) => list.filter((_, i) => i !== idx));
    showWorkflow(-1);
  };

  const load = () => {
    const cfg = settings();
    describeEl.value = cfg.describePrompt;
    instructionEl.value = cfg.instructionPrompt;
    comfyUrlEl.value = cfg.comfyUrl;
    setWorkflows(cfg.workflows);
    showWorkflow(cfg.workflows.findIndex((workflow) => workflow.name === cfg.activeWorkflow));
  };
  onMount(load);

  const save = async () => {
    stash();
    const names = workflows().map((workflow) => workflow.name);
    if (new Set(names).size !== names.length) {
      setError('Workflow names must be unique — the selected name identifies the /image workflow.');
      return;
    }
    for (const workflow of workflows()) {
      const invalid = workflowError(workflow.json);
      if (invalid) {
        setError(`Workflow "${workflow.name}" ${invalid}`);
        return;
      }
    }
    try {
      await savePluginSettings(ID, {
        describePrompt: describeEl.value,
        instructionPrompt: instructionEl.value,
        comfyUrl: comfyUrlEl.value.trim() || DEFAULTS.comfyUrl,
        workflows: workflows(),
        activeWorkflow: workflows()[selected()]?.name ?? '',
      });
      setError('');
      flashSaved();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const hasPrompt = () => /\{\{prompt\}\}/i.test(workflowText());
  const hasSeed = () => /\{\{seed\}\}/i.test(workflowText());

  return (
    <>
      <label>
        Character description prompt (sent to the model to describe the scene as an image prompt){' '}
        <MacroHelp />
      </label>
      <MacroTextarea ref={describeEl} placeholder={DEFAULTS.describePrompt} />
      <label>
        Instruction prompt for /image — {'{{instruction}}'} expands to the command argument{' '}
        <MacroHelp extra={[['{{instruction}}', 'The /image command argument']]} />
      </label>
      <MacroTextarea
        ref={instructionEl}
        extraKeys={['instruction']}
        placeholder="Leave empty to use the instruction verbatim"
      />
      <label>ComfyUI URL</label>
      <input ref={comfyUrlEl} placeholder={DEFAULTS.comfyUrl} />

      <label>Workflow used by /image (ComfyUI API format; none = describe only, no image)</label>
      <div class="key-row">
        <Select
          ref={pickerEl}
          onChange={(value) => pick(Number(value))}
          options={[
            { value: '-1', label: '— none (describe only) —' },
            ...workflows().map((workflow, i) => ({
              value: String(i),
              label: workflow.name || `Workflow ${i + 1}`,
            })),
          ]}
        />
        <button onClick={addWorkflow}>+ Add</button>
        <Show when={selected() !== -1}>
          <button class="danger-btn" onClick={deleteWorkflow}>
            Delete
          </button>
        </Show>
      </div>

      {/* Stays mounted (hidden by class) so the imperative refs survive selection changes. */}
      <div class="workflow-detail" classList={{ hidden: selected() === -1 }}>
        <label>Name</label>
        <input ref={nameEl} placeholder="Workflow name" />
        <label>
          Workflow JSON — export via ComfyUI's "Save (API Format)"{' '}
          <MacroHelp rows={WORKFLOW_MACROS} />
        </label>
        <MacroTextarea
          ref={workflowEl}
          keys={['prompt', 'seed']}
          class="mono"
          rows={12}
          onText={setWorkflowText}
          placeholder='{"3": {"class_type": "KSampler", "inputs": {"seed": {{seed}}, …}}, "6": {"inputs": {"text": "{{prompt}}", …}}, …}'
        />
        <Show when={workflowText().trim()}>
          <div class="macro-checks">
            <span classList={{ warn: !hasPrompt() }}>
              {hasPrompt()
                ? '✓ {{prompt}} found'
                : '✗ {{prompt}} missing — the generated description would not be used'}
            </span>
            <span classList={{ soft: !hasSeed() }}>
              {hasSeed()
                ? '✓ {{seed}} found'
                : "△ {{seed}} missing — every render will reuse the workflow's fixed seed"}
            </span>
          </div>
        </Show>
      </div>

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

/** Owns the rendering of this plugin's tool messages: collapsible prompt,
 * image with fullscreen viewer, header swiper (› past the end re-renders
 * with a fresh seed), render progress and error/retry. */
const messageView: PluginMessageView = {
  claims: (message) =>
    message.images.length > 0 ||
    message.imagePending ||
    message.hasImageRender ||
    message.name === 'Image prompt',
  create: (message, ctx) => {
    const [showPrompt, setShowPrompt] = createSignal(false);
    const [viewerOpen, setViewerOpen] = createSignal(false);
    const images = () => message().images;
    const activeImage = () => Math.min(message().activeImage, images().length - 1);
    const currentImage = () => images()[activeImage()];
    const promptCollapsed = () => images().length > 0;
    const canRender = () =>
      !message().imagePending && (message().hasImageRender || activeRenderConfig() != null);

    // In-flight guard: a double-click must not fire a second request that the
    // server would just 409 into an error toast.
    let swipeBusy = false;
    const imageSwipe = async (dir: 1 | -1) => {
      const idx = activeImage() + dir;
      if (idx < 0 || swipeBusy) return;
      swipeBusy = true;
      try {
        if (idx >= images().length) {
          if (!canRender()) return;
          await api.renderImage(
            message().id,
            message().hasImageRender ? undefined : activeRenderConfig(),
          );
        } else {
          await api.setActiveImage(message().id, idx);
        }
      } catch (err) {
        toast(errorMessage(err));
      } finally {
        swipeBusy = false;
      }
    };

    const Header = () => (
      <>
        <Show when={promptCollapsed()}>
          <button
            class="chip reasoning-chip"
            classList={{ 'chip-active': showPrompt() }}
            onClick={() => setShowPrompt(!showPrompt())}
          >
            Prompt {showPrompt() ? '▾' : '▸'}
          </button>
        </Show>
        <Show when={images().length > 0}>
          <span class="branch-nav">
            <button
              class="icon-btn"
              disabled={activeImage() <= 0}
              onClick={() => void imageSwipe(-1)}
            >
              ‹
            </button>
            {activeImage() + 1}/{images().length}
            <button
              class="icon-btn"
              disabled={activeImage() >= images().length - 1 && !canRender()}
              title={
                activeImage() >= images().length - 1
                  ? 'Generate another image (same prompt, new seed)'
                  : undefined
              }
              onClick={() => void imageSwipe(1)}
            >
              ›
            </button>
          </span>
        </Show>
        {/* The render only starts once the description is complete — no
            indicator while the text is still streaming in. */}
        <Show when={message().imagePending && !ctx.streaming()}>
          <span class="msg-image-pending">
            <span class="spinner" />
            <Show when={imageProgress()[message().id]} fallback={<span>Rendering…</span>}>
              {(progress) => (
                <>
                  <span class="img-progress">
                    <span
                      class="img-progress-fill"
                      style={{ width: `${Math.round((progress().value / progress().max) * 100)}%` }}
                    />
                  </span>
                  <span>
                    {progress().value}/{progress().max}
                  </span>
                </>
              )}
            </Show>
          </span>
        </Show>
      </>
    );

    const Body = () => (
      <>
        <Show when={!promptCollapsed() || showPrompt()}>
          <div class="msg-content">
            <Markdown content={message().content} streaming={ctx.streaming()} />
          </div>
        </Show>
        <Show when={currentImage()}>
          <img
            class="msg-image"
            src={currentImage()}
            alt="Generated image"
            onClick={() => setViewerOpen(true)}
          />
          <Show when={viewerOpen()}>
            <ImageViewer src={currentImage()!} onClose={() => setViewerOpen(false)} />
          </Show>
        </Show>
        <Show when={message().genMeta?.imageError && !message().imagePending}>
          <div class="msg-error">
            Image render failed: {message().genMeta!.imageError}{' '}
            <Show when={canRender()}>
              <button onClick={() => void imageSwipe(1)}>Retry</button>
            </Show>
          </div>
        </Show>
      </>
    );

    return { Header, Body };
  },
};

export const imageGenerationPlugin: Plugin = {
  id: ID,
  name: 'Image Generation',
  messageView,
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
