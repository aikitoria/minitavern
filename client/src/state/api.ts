import type {
  Character,
  Conversation,
  Endpoint,
  Persona,
  Preset,
  Settings,
  Template,
  TreeSnapshot,
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

export const api = {
  conversations: () => request<Conversation[]>('GET', '/api/conversations'),
  createConversation: (characterId: number | null) =>
    request<Conversation>('POST', '/api/conversations', { characterId }),
  patchConversation: (id: number, patch: Partial<Conversation>) =>
    request<Conversation>('PATCH', `/api/conversations/${id}`, patch),
  deleteConversation: (id: number) => request<void>('DELETE', `/api/conversations/${id}`),
  tree: (id: number) => request<TreeSnapshot>('GET', `/api/conversations/${id}/tree`),
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
  ) =>
    request<{ toolMessageId: number; activeLeafId: number }>(
      'POST',
      `/api/conversations/${conversationId}/tool`,
      { prompt, label, expectedActiveLeafId },
    ),

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
  deleteMessage: (messageId: number, expectedActiveLeafId: number | null) =>
    request<void>(
      'DELETE',
      `/api/messages/${messageId}?expectedActiveLeafId=${expectedActiveLeafId ?? 'null'}`,
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
