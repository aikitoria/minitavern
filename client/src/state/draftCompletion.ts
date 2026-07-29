import { createRoot, createSignal } from 'solid-js';
import { ApiError } from './api.ts';

const [draftCompletionActive, setDraftCompletionActive] = createRoot(() => createSignal(false));
export { draftCompletionActive };

let activeAbort: AbortController | null = null;

async function responseError(response: Response): Promise<ApiError> {
  let message = `${response.status}`;
  try {
    const payload = (await response.json()) as { error?: unknown };
    if (typeof payload.error === 'string') message = payload.error;
  } catch {
    /* keep status */
  }
  return new ApiError(response.status, message);
}

export async function completeComposerDraft(options: {
  conversationId: number;
  draft: string;
  expectedActiveLeafId: number | null;
  expectedMutationRevision: number;
  onText: (text: string) => void;
}): Promise<boolean> {
  if (activeAbort) return false;
  const abort = new AbortController();
  activeAbort = abort;
  setDraftCompletionActive(true);
  let suffix = '';
  let completed = false;
  try {
    const response = await fetch(`/api/conversations/${options.conversationId}/complete-draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        draft: options.draft,
        expectedActiveLeafId: options.expectedActiveLeafId,
        expectedMutationRevision: options.expectedMutationRevision,
      }),
      signal: abort.signal,
    });
    if (!response.ok || !response.body) throw await responseError(response);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const processLine = (line: string) => {
      if (!line.startsWith('data:')) return;
      const payload = JSON.parse(line.slice(5)) as { d?: unknown; error?: unknown; done?: unknown };
      if (typeof payload.error === 'string') throw new ApiError(502, payload.error);
      if (typeof payload.d === 'string' && payload.d) {
        suffix += payload.d;
        options.onText(options.draft + suffix);
      }
      if (payload.done === true) completed = true;
    };
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        processLine(line);
      }
    }
    buffer += decoder.decode();
    for (const line of buffer.split('\n')) processLine(line.trim());
    if (!completed) throw new ApiError(502, 'draft completion stream ended before completion');
    return true;
  } catch (err) {
    options.onText(options.draft);
    if (abort.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
      return false;
    }
    throw err;
  } finally {
    if (activeAbort === abort) activeAbort = null;
    setDraftCompletionActive(false);
  }
}

export function stopDraftCompletion(): void {
  activeAbort?.abort();
}
