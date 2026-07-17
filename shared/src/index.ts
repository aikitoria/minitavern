/** 'tool' messages are plugin output shown in the chat but excluded from prompt history. */
export type Role = 'user' | 'assistant' | 'system' | 'tool';
export type MessageStatus = 'done' | 'streaming' | 'error' | 'stopped';
export type GenerationKind = 'normal' | 'speculative';

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
  generationKind: GenerationKind;
  createdAt: number;
}

export interface Conversation {
  id: number;
  title: string;
  characterId: number | null;
  personaId: number | null;
  /** Endpoint override for this conversation; null = the global active endpoint. */
  endpointId: number | null;
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
  /** Inline template override; replaces templateId with the same three settings. */
  customTemplate: CustomTemplate | null;
  createdAt: number;
}

/** The settings a template entity has, inlined on a character. */
export interface CustomTemplate {
  content: string;
  userPrologue: string;
  prefixNames: boolean;
  usesPersonas: boolean;
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
  /** When false, chats using this template ignore personas entirely ({{user}} = "User"). */
  usesPersonas: boolean;
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
  /** Whether a secret is stored; the secret itself is never returned by the API. */
  hasApiKey: boolean;
  models: string[];
  /** The model used for generations through this endpoint. */
  model: string | null;
  /** Sampling settings sent with every generation through this endpoint. */
  genParams: GenParams;
  /** How assistant-prefill continuation is requested: generic trailing message,
   * vLLM's continue_final_message, or DeepSeek's beta prefix flag. */
  prefillMode: 'none' | 'vllm' | 'deepseek';
  createdAt: number;
}

export interface Settings {
  /** Monotonic server revision used to reject stale cross-device writes. */
  revision: number;
  defaultPresetId: number | null;
  /** The single endpoint all generations go through. */
  activeEndpointId: number | null;
  defaultPersonaId: number | null;
  defaultTemplateId: number | null;
  /** Auto-expand the thinking block while a model reasons with no answer text yet. */
  autoExpandThinking: boolean;
  /** Keep one unread assistant sibling prepared ahead of the active reply. */
  backgroundSwipeGeneration: boolean;
  /** Per-plugin settings blobs, keyed by plugin id (shapes are plugin-defined). */
  pluginSettings: Record<string, Record<string, unknown>>;
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
  revision: 0,
  defaultPresetId: null,
  activeEndpointId: null,
  defaultPersonaId: null,
  defaultTemplateId: null,
  autoExpandThinking: false,
  backgroundSwipeGeneration: false,
  pluginSettings: {},
};

export interface TreeSnapshot {
  conversationId: number;
  messages: Message[];
  activeLeafId: number | null;
}

export type InvalidateEntity =
  'conversations' | 'characters' | 'presets' | 'templates' | 'personas' | 'endpoints' | 'settings';

/** Structural view of a message; body fields travel separately in tree patches. */
export interface TreeNode {
  id: number;
  parentId: number | null;
  activeChildId: number | null;
  status: MessageStatus;
  generationKind: GenerationKind;
}

/** Server -> client WebSocket events. Delta frames are deliberately terse. */
export type ServerEvent =
  | { t: 'hello' }
  | { t: 'invalidate'; entity: InvalidateEntity }
  /** Full snapshot; sent on subscribe (and used as the client's resync fallback). */
  | { t: 'tree'; conversationId: number; messages: Message[]; activeLeafId: number | null }
  /**
   * Incremental structural update: `nodes` lists every message in the tree
   * (absent ids were deleted); `messages` carries full bodies only for
   * messages created or edited since the last frame.
   */
  | {
      t: 'treePatch';
      conversationId: number;
      activeLeafId: number | null;
      nodes: TreeNode[];
      messages: Message[];
    }
  | { t: 'delta'; mid: number; d?: string; r?: string }
  | { t: 'final'; conversationId: number; message: Message };

/** Client -> server WebSocket commands. */
export type ClientCommand = { sub: number | null };
