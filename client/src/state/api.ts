import type {
  Character,
  Conversation,
  Endpoint,
  Persona,
  Preset,
  Settings,
  Template,
} from '@minitavern/shared';

interface RequestOptions {
  rawBody?: BodyInit;
  contentType?: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(
  method: string,
  url: string,
  body?: unknown,
  options?: RequestOptions,
): Promise<T> {
  const hasRawBody = options?.rawBody !== undefined;
  const hasJsonBody = body !== undefined;
  const res = await fetch(url, {
    method,
    headers:
      hasRawBody || hasJsonBody
        ? { 'content-type': options?.contentType ?? 'application/json' }
        : {},
    body: hasRawBody ? options.rawBody : hasJsonBody ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let message = `${res.status}`;
    try {
      const json = (await res.json()) as { error?: string };
      if (json.error) message = json.error;
    } catch {
      /* keep status */
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Error-message extraction shared by the non-JSON (SSE / binary) endpoints. */
async function errorFromResponse(res: Response): Promise<ApiError> {
  let message = `${res.status}`;
  try {
    const json = (await res.json()) as { error?: string };
    if (json.error) message = json.error;
  } catch {
    /* keep status */
  }
  return new ApiError(res.status, message);
}

/** Reads the avatar prompt SSE stream ({d} deltas, {error}, {done}), invoking
 * onDelta per token and resolving with the assembled text. */
async function streamAvatarPrompt(
  kind: 'character' | 'persona',
  id: number,
  prompt: string,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch(
    `/api/${kind === 'character' ? 'characters' : 'personas'}/${id}/avatar/prompt`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt }),
      signal: signal ?? null,
    },
  );
  if (!res.ok || !res.body) throw await errorFromResponse(res);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = JSON.parse(line.slice(5)) as { d?: string; error?: string };
      if (payload.error) throw new ApiError(502, payload.error);
      if (payload.d) {
        text += payload.d;
        onDelta(payload.d);
      }
    }
  }
  return text;
}

/** Stateless avatar render: prompt + workflow in, image bytes out. A jobId
 * gets live sampler progress as renderProgress WS events. */
async function renderAvatar(body: {
  prompt: string;
  image: { workflow: string; comfyUrl: string };
  jobId?: string;
}): Promise<Blob> {
  const res = await fetch('/api/avatar/render', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await errorFromResponse(res);
  return res.blob();
}

export const api = {
  conversations: () => request<Conversation[]>('GET', '/api/conversations'),
  createConversation: (characterId: number | null) =>
    request<Conversation>('POST', '/api/conversations', { characterId }),
  patchConversation: (id: number, patch: Partial<Conversation>) =>
    request<Conversation>('PATCH', `/api/conversations/${id}`, patch),
  deleteConversation: (id: number) => request<void>('DELETE', `/api/conversations/${id}`),
  duplicateConversation: (id: number) =>
    request<Conversation>('POST', `/api/conversations/${id}/duplicate`),
  search: (q: string) =>
    request<{ conversation: Conversation; snippet: string | null }[]>(
      'GET',
      `/api/search?q=${encodeURIComponent(q)}`,
    ),
  trace: (id: number) =>
    request<{ messages: { role: string; content: string }[]; namePrefill: string | null }>(
      'GET',
      `/api/conversations/${id}/trace`,
    ),
  send: (conversationId: number, content: string, expectedActiveLeafId: number | null) =>
    request<{ userMessageId: number; assistantMessageId: number }>(
      'POST',
      `/api/conversations/${conversationId}/messages`,
      { content, expectedActiveLeafId },
    ),
  deleteTail: (conversationId: number, count: number, expectedActiveLeafId: number | null) =>
    request<{ activeLeafId: number | null; deletedSiblingRoots: number }>(
      'POST',
      `/api/conversations/${conversationId}/delete-tail`,
      { count, expectedActiveLeafId },
    ),
  toolGenerate: (
    conversationId: number,
    prompt: string,
    label: string,
    expectedActiveLeafId: number | null,
    image?: { workflow: string; comfyUrl: string },
  ) =>
    request<{ toolMessageId: number; activeLeafId: number }>(
      'POST',
      `/api/conversations/${conversationId}/tool`,
      { prompt, label, expectedActiveLeafId, ...(image ? { image } : {}) },
    ),

  moveMessage: (messageId: number, direction: 'up' | 'down', expectedActiveLeafId: number | null) =>
    request<{ activeLeafId: number | null }>('POST', `/api/messages/${messageId}/move`, {
      direction,
      expectedActiveLeafId,
    }),
  duplicateMessage: (messageId: number, expectedActiveLeafId: number | null) =>
    request<{ messageId: number; activeLeafId: number }>(
      'POST',
      `/api/messages/${messageId}/duplicate`,
      { expectedActiveLeafId },
    ),
  renderImage: (messageId: number, fallbackConfig?: { workflow: string; comfyUrl: string }) =>
    request<{ rendering: boolean }>(
      'POST',
      `/api/messages/${messageId}/render-image`,
      fallbackConfig ?? {},
    ),
  setActiveImage: (messageId: number, index: number) =>
    request<void>('POST', `/api/messages/${messageId}/active-image`, { index }),

  editMessage: (messageId: number, content: string, expectedActiveLeafId: number | null) =>
    request<unknown>('PATCH', `/api/messages/${messageId}`, { content, expectedActiveLeafId }),
  editBranch: (messageId: number, content: string, expectedActiveLeafId: number | null) =>
    request<{ messageId: number }>('POST', `/api/messages/${messageId}/edit-branch`, {
      content,
      expectedActiveLeafId,
    }),
  activate: (messageId: number, expectedActiveLeafId: number | null) =>
    request<{ activeLeafId: number }>('POST', `/api/messages/${messageId}/activate`, {
      expectedActiveLeafId,
    }),
  advance: (messageId: number, expectedActiveLeafId: number | null) =>
    request<{ activeLeafId: number; assistantMessageId: number | null }>(
      'POST',
      `/api/messages/${messageId}/advance`,
      { expectedActiveLeafId },
    ),
  regenerate: (messageId: number, instruction: string, expectedActiveLeafId: number | null) =>
    request<{ activeLeafId: number; assistantMessageId: number }>(
      'POST',
      `/api/messages/${messageId}/regenerate`,
      { instruction, expectedActiveLeafId },
    ),
  deleteMessage: (messageId: number, expectedActiveLeafId: number | null) =>
    request<void>(
      'DELETE',
      `/api/messages/${messageId}?expectedActiveLeafId=${expectedActiveLeafId ?? 'null'}`,
    ),
  deleteSwipe: (messageId: number, expectedActiveLeafId: number | null) =>
    request<{ activeLeafId: number | null }>(
      'DELETE',
      `/api/messages/${messageId}/swipe?expectedActiveLeafId=${expectedActiveLeafId ?? 'null'}`,
    ),
  resume: (messageId: number, expectedActiveLeafId: number | null) =>
    request<{ assistantMessageId: number }>('POST', `/api/messages/${messageId}/continue`, {
      expectedActiveLeafId,
    }),
  stopGeneration: (messageId: number) =>
    request<{ stopped: boolean }>('POST', `/api/generations/${messageId}/stop`),

  characters: () => request<Character[]>('GET', '/api/characters'),
  createCharacter: (data: Partial<Character>) =>
    request<Character>('POST', '/api/characters', data),
  patchCharacter: (id: number, data: Partial<Character>) =>
    request<Character>('PATCH', `/api/characters/${id}`, data),
  deleteCharacter: (id: number) => request<void>('DELETE', `/api/characters/${id}`),
  uploadCharacterAvatar: (id: number, file: File) =>
    request<Character>('PUT', `/api/characters/${id}/avatar`, undefined, {
      rawBody: file,
      contentType: file.type,
    }),
  deleteCharacterAvatar: (id: number) =>
    request<Character>('DELETE', `/api/characters/${id}/avatar`),
  importCard: (file: File) =>
    request<Character>('POST', '/api/characters/import-card', undefined, {
      rawBody: file,
      contentType: 'application/octet-stream',
    }),

  templates: () => request<Template[]>('GET', '/api/templates'),
  createTemplate: (data: Partial<Template>) => request<Template>('POST', '/api/templates', data),
  patchTemplate: (id: number, data: Partial<Template>) =>
    request<Template>('PATCH', `/api/templates/${id}`, data),
  deleteTemplate: (id: number) => request<void>('DELETE', `/api/templates/${id}`),

  presets: () => request<Preset[]>('GET', '/api/presets'),
  createPreset: (data: Partial<Preset>) => request<Preset>('POST', '/api/presets', data),
  patchPreset: (id: number, data: Partial<Preset>) =>
    request<Preset>('PATCH', `/api/presets/${id}`, data),
  deletePreset: (id: number) => request<void>('DELETE', `/api/presets/${id}`),

  personas: () => request<Persona[]>('GET', '/api/personas'),
  createPersona: (data: Partial<Persona>) => request<Persona>('POST', '/api/personas', data),
  patchPersona: (id: number, data: Partial<Persona>) =>
    request<Persona>('PATCH', `/api/personas/${id}`, data),
  deletePersona: (id: number) => request<void>('DELETE', `/api/personas/${id}`),
  uploadPersonaAvatar: (id: number, file: File) =>
    request<Persona>('PUT', `/api/personas/${id}/avatar`, undefined, {
      rawBody: file,
      contentType: file.type,
    }),
  deletePersonaAvatar: (id: number) => request<Persona>('DELETE', `/api/personas/${id}/avatar`),

  streamAvatarPrompt,
  renderAvatar,

  endpoints: () => request<Endpoint[]>('GET', '/api/endpoints'),
  createEndpoint: (data: Partial<Endpoint>) => request<Endpoint>('POST', '/api/endpoints', data),
  patchEndpoint: (id: number, data: Partial<Endpoint>) =>
    request<Endpoint>('PATCH', `/api/endpoints/${id}`, data),
  deleteEndpoint: (id: number) => request<void>('DELETE', `/api/endpoints/${id}`),
  fetchModels: (id: number) => request<string[]>('GET', `/api/endpoints/${id}/models`),

  settings: () => request<Settings>('GET', '/api/settings'),
  putSettings: (settings: Partial<Settings>, expectedRevision: number) =>
    request<Settings>('PUT', '/api/settings', { ...settings, expectedRevision }),
};
