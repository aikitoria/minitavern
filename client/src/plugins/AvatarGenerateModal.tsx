import { Show, createSignal, onCleanup, onMount } from 'solid-js';
import { api } from '../state/api.ts';
import { renderProgress } from '../state/store.ts';
import { errorMessage } from '../util.ts';
import Modal from '../components/Modal.tsx';
import { avatarPromptTemplate, avatarRenderConfig } from './imageGeneration.tsx';

/**
 * Interactive avatar generation popup: streams the LLM portrait prompt into
 * an editable textarea (macros expanded server-side from the entity), then
 * renders it with the configured avatar workflow. The user can regenerate
 * (fresh seed), edit the text and render again, save the result as the
 * avatar, or cancel — nothing is stored until "Use this avatar" uploads the
 * PNG through the normal avatar route.
 */
export default function AvatarGenerateModal(props: {
  kind: 'character' | 'persona';
  id: number;
  onClose: () => void;
}) {
  const [text, setText] = createSignal('');
  const [streaming, setStreaming] = createSignal(true);
  const [rendering, setRendering] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [imageUrl, setImageUrl] = createSignal<string | null>(null);
  const [error, setError] = createSignal('');
  const abort = new AbortController();
  /** Correlates this modal's renders with renderProgress WS events. */
  const jobId = crypto.randomUUID();

  /** Sampler step progress while rendering (falls back to a bare spinner
   * until the first progress event arrives). */
  const Progress = () => (
    <Show when={renderProgress()[jobId]} fallback={<span class="spinner spinner-wait" />}>
      {(p) => (
        <>
          <span class="img-progress">
            <span
              class="img-progress-fill"
              style={{ width: `${Math.round((p().value / p().max) * 100)}%` }}
            />
          </span>
          <span class="avatar-gen-steps">
            {p().value}/{p().max}
          </span>
        </>
      )}
    </Show>
  );

  const render = async () => {
    const image = avatarRenderConfig();
    const prompt = text().trim();
    if (!image) {
      setError('Select a workflow in Settings → Tools → Image Generation first.');
      return;
    }
    if (!prompt) {
      setError('Write a prompt first.');
      return;
    }
    setRendering(true);
    setError('');
    try {
      const blob = await api.renderAvatar({ prompt, image, jobId });
      const url = URL.createObjectURL(blob);
      const old = imageUrl();
      setImageUrl(url);
      if (old) URL.revokeObjectURL(old);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRendering(false);
    }
  };

  onMount(() => {
    void (async () => {
      try {
        await api.streamAvatarPrompt(
          props.kind,
          props.id,
          avatarPromptTemplate(),
          (d) => setText((t) => t + d),
          abort.signal,
        );
      } catch (err) {
        if (!abort.signal.aborted) setError(errorMessage(err));
      } finally {
        setStreaming(false);
      }
      // The portrait prompt is ready — render it right away.
      if (!abort.signal.aborted) await render();
    })();
  });

  onCleanup(() => {
    abort.abort();
    const url = imageUrl();
    if (url) URL.revokeObjectURL(url);
  });

  const save = async () => {
    const url = imageUrl();
    if (!url) return;
    setSaving(true);
    setError('');
    try {
      const blob = await (await fetch(url)).blob();
      const file = new File([blob], 'avatar.png', { type: blob.type || 'image/png' });
      // The avatar route enforces PNG — a non-PNG workflow output fails here.
      if (props.kind === 'character') await api.uploadCharacterAvatar(props.id, file);
      else await api.uploadPersonaAvatar(props.id, file);
      props.onClose();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  };

  const busy = () => streaming() || rendering() || saving();

  return (
    <Modal title="Generate avatar" onClose={props.onClose}>
      <div class="avatar-gen form">
        <label>
          Portrait prompt{' '}
          <Show when={streaming()}>
            <span class="spinner spinner-wait" />
          </Show>
        </label>
        <textarea
          rows={5}
          value={text()}
          readOnly={streaming()}
          placeholder="The model is writing the portrait prompt…"
          onInput={(e) => setText(e.currentTarget.value)}
        />
        <div class="avatar-gen-preview">
          <Show
            when={imageUrl()}
            fallback={
              <div class="avatar-gen-placeholder">
                <Show when={rendering()} fallback={streaming() ? 'Waiting for the prompt…' : null}>
                  <Progress />
                </Show>
              </div>
            }
          >
            {(url) => <img src={url()} alt="Generated avatar" />}
          </Show>
          <Show when={rendering() && imageUrl()}>
            <Progress />
          </Show>
        </div>
        <div class="form-actions">
          <button class="primary-btn" disabled={!imageUrl() || busy()} onClick={() => void save()}>
            {saving() ? 'Saving…' : 'Use this avatar'}
          </button>
          <button disabled={busy()} onClick={() => void render()}>
            {imageUrl() ? 'Regenerate' : 'Render'}
          </button>
          <button onClick={props.onClose}>Cancel</button>
        </div>
        <Show when={error()}>
          <p class="hint">{error()}</p>
        </Show>
      </div>
    </Modal>
  );
}
