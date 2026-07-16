import { For, Show, createSignal } from 'solid-js';
import type { Endpoint, GenParams } from '@minitavern/shared';
import { api } from '../../state/api.ts';
import { state } from '../../state/store.ts';
import { createSavedFlash, createDetailNav } from '../../util.ts';

export default function EndpointsTab() {
  const [selectedId, setSelectedId] = createSignal<number | 'new'>('new');
  const [saved, flashSaved] = createSavedFlash();
  const nav = createDetailNav();
  const [status, setStatus] = createSignal('');
  const [model, setModel] = createSignal('');
  let nameEl!: HTMLInputElement;
  let urlEl!: HTMLInputElement;
  let keyEl!: HTMLInputElement;
  let tempEl!: HTMLInputElement;
  let topPEl!: HTMLInputElement;
  let maxTokEl!: HTMLInputElement;
  let freqEl!: HTMLInputElement;
  let presEl!: HTMLInputElement;
  let prefillEl!: HTMLSelectElement;

  const selected = () => state.endpoints.find((e) => e.id === selectedId());

  const select = (id: number | 'new') => {
    nav.openDetail();
    setSelectedId(id);
    setStatus('');
    const ep = state.endpoints.find((e) => e.id === id);
    nameEl.value = ep?.name ?? '';
    urlEl.value = ep?.baseUrl ?? '';
    keyEl.value = ep?.apiKey ?? '';
    setModel(ep?.model ?? '');
    tempEl.value = String(ep?.genParams.temperature ?? '');
    topPEl.value = String(ep?.genParams.topP ?? '');
    maxTokEl.value = String(ep?.genParams.maxTokens ?? '');
    freqEl.value = String(ep?.genParams.frequencyPenalty ?? '');
    presEl.value = String(ep?.genParams.presencePenalty ?? '');
    prefillEl.value = ep?.prefillMode ?? 'none';
  };

  const data = () => {
    const genParams: GenParams = {};
    if (tempEl.value !== '') genParams.temperature = Number(tempEl.value);
    if (topPEl.value !== '') genParams.topP = Number(topPEl.value);
    if (maxTokEl.value !== '') genParams.maxTokens = Number(maxTokEl.value);
    if (freqEl.value !== '') genParams.frequencyPenalty = Number(freqEl.value);
    if (presEl.value !== '') genParams.presencePenalty = Number(presEl.value);
    return {
      name: nameEl.value,
      baseUrl: urlEl.value,
      apiKey: keyEl.value,
      model: model() || null,
      genParams,
      prefillMode: prefillEl.value as Endpoint['prefillMode'],
    };
  };

  const save = async () => {
    try {
      const id = selectedId();
      const saved =
        id === 'new' ? await api.createEndpoint(data()) : await api.patchEndpoint(id, data());
      setSelectedId(saved.id);
      setStatus('');
      flashSaved();
    } catch (err) {
      setStatus(String(err));
    }
  };

  const remove = async () => {
    const id = selectedId();
    if (id === 'new' || !confirm('Delete this endpoint?')) return;
    await api.deleteEndpoint(id);
    select('new');
    nav.closeDetail(); // mobile: back to the list after deleting
  };

  const fetchModels = async () => {
    const id = selectedId();
    if (id === 'new') return;
    setStatus('Fetching models…');
    try {
      const models = await api.fetchModels(id);
      setStatus(`${models.length} models available.`);
      if (!model() && models.length > 0) setModel(models[0]!);
    } catch (err) {
      setStatus(String(err));
    }
  };

  const models = () => selected()?.models ?? [];

  return (
    <div class="master-detail" classList={{ 'detail-open': nav.detailOpen() }}>
      <div class="entity-list">
        <button classList={{ active: selectedId() === 'new' }} onClick={() => select('new')}>
          + New endpoint
        </button>
        <For each={state.endpoints}>
          {(ep) => (
            <button classList={{ active: selectedId() === ep.id }} onClick={() => select(ep.id)}>
              {ep.name}
            </button>
          )}
        </For>
      </div>
      <div class="form">
        <button class="detail-back" onClick={nav.closeDetail}>
          ‹ Back to list
        </button>
        <label>Name</label>
        <input ref={nameEl} placeholder="Local llama.cpp" />
        <label>Base URL (OpenAI-compatible, up to /v1)</label>
        <input ref={urlEl} placeholder="http://192.168.1.10:8080/v1" />
        <label>API key (optional)</label>
        <input ref={keyEl} type="password" placeholder="sk-…" />

        <label>Model</label>
        <Show
          when={models().length > 0}
          fallback={
            <input
              value={model()}
              onChange={(e) => setModel(e.currentTarget.value)}
              placeholder="model id (use Fetch models to list)"
            />
          }
        >
          <select value={model()} onChange={(e) => setModel(e.currentTarget.value)}>
            <option value="">— none —</option>
            <Show when={model() && !models().includes(model())}>
              <option value={model()}>{model()} (custom)</option>
            </Show>
            <For each={models()}>{(m) => <option value={m}>{m}</option>}</For>
          </select>
        </Show>

        <label>Sampling</label>
        <div class="param-grid">
          <div>
            <label>Temperature</label>
            <input ref={tempEl} type="number" step="0.05" min="0" max="2" />
          </div>
          <div>
            <label>Top P</label>
            <input ref={topPEl} type="number" step="0.05" min="0" max="1" />
          </div>
          <div>
            <label>Max tokens</label>
            <input ref={maxTokEl} type="number" step="1" min="1" />
          </div>
          <div>
            <label>Freq. penalty</label>
            <input ref={freqEl} type="number" step="0.05" min="-2" max="2" />
          </div>
          <div>
            <label>Pres. penalty</label>
            <input ref={presEl} type="number" step="0.05" min="-2" max="2" />
          </div>
        </div>
        <p class="hint">Empty fields are omitted from requests (backend defaults apply).</p>

        <label>Prefill support (for resume and speaker-name prefill)</label>
        <select ref={prefillEl}>
          <option value="none">Generic (trailing assistant message)</option>
          <option value="vllm">vLLM (continue_final_message)</option>
          <option value="deepseek">DeepSeek beta (prefix flag, needs /beta base URL)</option>
        </select>

        <div class="form-actions">
          <button class="primary-btn" onClick={() => void save()}>
            {selectedId() === 'new' ? 'Create' : 'Save'}
          </button>
          <button onClick={() => select(selectedId())}>Discard</button>
          <Show when={selectedId() !== 'new'}>
            <button onClick={() => void fetchModels()}>Fetch models</button>
            <button class="danger-btn" onClick={() => void remove()}>
              Delete
            </button>
          </Show>
          <Show when={saved()}>
            <span class="saved-flash">✓ Saved</span>
          </Show>
        </div>
        <Show when={status()}>
          <p class="hint">{status()}</p>
        </Show>
      </div>
    </div>
  );
}
