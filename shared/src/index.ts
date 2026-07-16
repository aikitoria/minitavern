export type Role = 'user' | 'assistant' | 'system';
export type MessageStatus = 'done' | 'streaming' | 'error' | 'stopped';

export interface GenParams {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
}

export interface GenMeta {
  error?: string;
  finishReason?: string;
  usage?: { promptTokens?: number; completionTokens?: number };
}

export interface Message {
  id: number;
  conversationId: number;
  parentId: number | null;
  role: Role;
  content: string;
  reasoning: string | null;
  /** Speaker name the message was sent with (assistant messages); null = character default. */
  name: string | null;
  status: MessageStatus;
  activeChildId: number | null;
  model: string | null;
  genMeta: GenMeta | null;
  createdAt: number;
}

export interface Conversation {
  id: number;
  title: string;
  characterId: number | null;
  personaId: number | null;
  /** Current assistant speaker name (set via /char); null = character's name. */
  speakerName: string | null;
  activeLeafId: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface Character {
  id: number;
  name: string;
  avatar: string | null;
  personality: string;
  scenario: string;
  firstMessage: string;
  presetId: number | null;
  customPrompt: string | null;
  templateId: number | null;
  createdAt: number;
}

export interface Preset {
  id: number;
  name: string;
  content: string;
  createdAt: number;
}

export interface Template {
  id: number;
  name: string;
  /** Template for the system message. */
  content: string;
  /** Optional fake first user message (e.g. introducing the character); empty = not emitted. */
  userPrologue: string;
  /** Prefix speaker names into message contents ("User: …", "Char: …") and prefill "Char:" for the reply. */
  prefixNames: boolean;
  createdAt: number;
}

export interface Persona {
  id: number;
  name: string;
  avatar: string | null;
  description: string;
  createdAt: number;
}

export interface Endpoint {
  id: number;
  name: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
  /** The model used for generations through this endpoint. */
  model: string | null;
  /** Sampling settings sent with every generation through this endpoint. */
  genParams: GenParams;
  createdAt: number;
}

export interface Settings {
  defaultPresetId: number | null;
  /** The single endpoint all generations go through. */
  activeEndpointId: number | null;
  defaultPersonaId: number | null;
  defaultTemplateId: number | null;
  /** Auto-expand the thinking block while a model reasons with no answer text yet. */
  autoExpandThinking: boolean;
}

/**
 * Controls how the system message is assembled. Slots: {{system}} (preset or
 * custom prompt), {{personality}}, {{persona}}, {{scenario}}, plus {{char}} /
 * {{user}} names. {{#if x}}...{{/if}} blocks are dropped when x is empty.
 */
export const DEFAULT_PROMPT_TEMPLATE = `{{system}}

{{#if personality}}{{char}}'s personality:
{{personality}}{{/if}}

{{#if persona}}About {{user}}:
{{persona}}{{/if}}

{{#if scenario}}Scenario:
{{scenario}}{{/if}}`;

export const DEFAULT_SETTINGS: Settings = {
  defaultPresetId: null,
  activeEndpointId: null,
  defaultPersonaId: null,
  defaultTemplateId: null,
  autoExpandThinking: false,
};

export interface TreeSnapshot {
  conversationId: number;
  messages: Message[];
  activeLeafId: number | null;
}

export type InvalidateEntity =
  'conversations' | 'characters' | 'presets' | 'templates' | 'personas' | 'endpoints' | 'settings';

/** Server -> client WebSocket events. Delta frames are deliberately terse. */
export type ServerEvent =
  | { t: 'hello' }
  | { t: 'invalidate'; entity: InvalidateEntity }
  | { t: 'tree'; conversationId: number; messages: Message[]; activeLeafId: number | null }
  | { t: 'delta'; mid: number; d?: string; r?: string }
  | { t: 'final'; conversationId: number; message: Message };

/** Client -> server WebSocket commands. */
export type ClientCommand = { sub: number | null };
