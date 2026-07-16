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

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let message = `${res.status}`;
    try {
      const json = (await res.json()) as { error?: string };
      if (json.error) message = json.error;
    } catch {
      /* keep status */
    }
    throw new Error(message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

async function upload<T>(method: string, url: string, file: Blob, contentType: string): Promise<T> {
  const res = await fetch(url, { method, headers: { 'content-type': contentType }, body: file });
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(json.error ?? `${res.status}`);
  }
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
  send: (conversationId: number, content: string) =>
    request<{ userMessageId: number; assistantMessageId: number }>(
      'POST',
      `/api/conversations/${conversationId}/messages`,
      { content },
    ),

  regenerate: (messageId: number) =>
    request<{ assistantMessageId: number }>('POST', `/api/messages/${messageId}/regenerate`),
  editMessage: (messageId: number, content: string) =>
    request<unknown>('PATCH', `/api/messages/${messageId}`, { content }),
  editBranch: (messageId: number, content: string) =>
    request<{ messageId: number }>('POST', `/api/messages/${messageId}/edit-branch`, { content }),
  activate: (messageId: number) =>
    request<{ activeLeafId: number }>('POST', `/api/messages/${messageId}/activate`),
  deleteMessage: (messageId: number) => request<void>('DELETE', `/api/messages/${messageId}`),
  resume: (messageId: number) =>
    request<{ assistantMessageId: number }>('POST', `/api/messages/${messageId}/continue`),
  stopGeneration: (messageId: number) =>
    request<{ stopped: boolean }>('POST', `/api/generations/${messageId}/stop`),

  characters: () => request<Character[]>('GET', '/api/characters'),
  createCharacter: (data: Partial<Character>) =>
    request<Character>('POST', '/api/characters', data),
  patchCharacter: (id: number, data: Partial<Character>) =>
    request<Character>('PATCH', `/api/characters/${id}`, data),
  deleteCharacter: (id: number) => request<void>('DELETE', `/api/characters/${id}`),
  uploadCharacterAvatar: (id: number, file: File) =>
    upload<Character>('PUT', `/api/characters/${id}/avatar`, file, file.type),
  importCard: (file: File) =>
    upload<Character>('POST', '/api/characters/import-card', file, 'application/octet-stream'),

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
    upload<Persona>('PUT', `/api/personas/${id}/avatar`, file, file.type),

  endpoints: () => request<Endpoint[]>('GET', '/api/endpoints'),
  createEndpoint: (data: Partial<Endpoint>) => request<Endpoint>('POST', '/api/endpoints', data),
  patchEndpoint: (id: number, data: Partial<Endpoint>) =>
    request<Endpoint>('PATCH', `/api/endpoints/${id}`, data),
  deleteEndpoint: (id: number) => request<void>('DELETE', `/api/endpoints/${id}`),
  fetchModels: (id: number) => request<string[]>('GET', `/api/endpoints/${id}/models`),

  settings: () => request<Settings>('GET', '/api/settings'),
  putSettings: (settings: Partial<Settings>) => request<Settings>('PUT', '/api/settings', settings),
};
