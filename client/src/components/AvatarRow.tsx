import { Show, createSignal } from 'solid-js';
import { errorMessage } from '../util.ts';
import Avatar from './Avatar.tsx';

/** Avatar preview + hidden-file-input upload row for the character/persona editors. */
export default function AvatarRow(props: {
  src: string | null | undefined;
  name: string;
  upload: (file: File) => Promise<unknown>;
  /** Delete the stored avatar; the row falls back to the initial letter. */
  remove: () => Promise<unknown>;
  /** LLM+ComfyUI avatar generation (image plugin); omitted when unavailable. */
  generate?: () => Promise<void>;
  onDone: () => void;
  onError: (message: string) => void;
}) {
  let input!: HTMLInputElement;
  const [generating, setGenerating] = createSignal(false);
  const uploadFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      await props.upload(file);
      props.onDone();
    } catch (err) {
      props.onError(errorMessage(err));
    }
  };
  const remove = async () => {
    try {
      await props.remove();
      props.onDone();
    } catch (err) {
      props.onError(errorMessage(err));
    }
  };
  const generate = async () => {
    if (!props.generate || generating()) return;
    setGenerating(true);
    try {
      await props.generate();
    } finally {
      setGenerating(false);
    }
  };
  return (
    <div class="avatar-row">
      <Avatar src={props.src} name={props.name} />
      <button onClick={() => input.click()}>Change avatar</button>
      <Show when={props.src}>
        <button onClick={() => void remove()}>Remove</button>
      </Show>
      <Show when={props.generate}>
        <button disabled={generating()} onClick={() => void generate()}>
          <Show when={generating()} fallback="Generate">
            <span class="spinner" /> Generating…
          </Show>
        </button>
      </Show>
      <input
        ref={input}
        type="file"
        accept="image/png"
        hidden
        onChange={(e) => void uploadFile(e.currentTarget.files?.[0])}
      />
    </div>
  );
}
