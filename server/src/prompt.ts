import type { Character, Conversation, Message, Persona, Role, Template } from '@minitavern/shared';
import { DEFAULT_PROMPT_TEMPLATE } from '@minitavern/shared';
import { stmt, toCharacter, toPersona, toPreset, toTemplate } from './db.ts';
import { getSettings } from './settingsStore.ts';

export interface ChatMessage {
  /** Upstream chat roles only — 'tool' messages never leave the server. */
  role: Exclude<Role, 'tool'>;
  content: string;
}

export function getCharacter(id: number | null): Character | null {
  if (id == null) return null;
  const row = stmt('SELECT * FROM characters WHERE id = ?').get(id) as
    Record<string, unknown> | undefined;
  return row ? toCharacter(row) : null;
}

export function getPersona(id: number | null): Persona | null {
  if (id == null) return null;
  const row = stmt('SELECT * FROM personas WHERE id = ?').get(id) as
    Record<string, unknown> | undefined;
  return row ? toPersona(row) : null;
}

function getPresetContent(id: number | null): string | null {
  if (id == null) return null;
  const row = stmt('SELECT * FROM presets WHERE id = ?').get(id) as
    Record<string, unknown> | undefined;
  return row ? toPreset(row).content : null;
}

function getTemplate(id: number | null): Template | null {
  if (id == null) return null;
  const row = stmt('SELECT * FROM templates WHERE id = ?').get(id) as
    Record<string, unknown> | undefined;
  return row ? toTemplate(row) : null;
}

export function substituteMacros(text: string, charName: string, userName: string): string {
  return text.replaceAll(/\{\{(char|user)\}\}/gi, (_, key: string) =>
    key.toLowerCase() === 'char' ? charName : userName,
  );
}

/**
 * Renders the prompt template: {{#if key}}...{{/if}} blocks are dropped when
 * the slot is empty, {{key}} slots are substituted, and leftover blank runs
 * are collapsed so a natural-looking template produces clean output.
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  // Innermost-first (body may not contain another opener), looped to fixpoint so
  // nested blocks resolve outward instead of the first opener grabbing the first closer.
  // vars is a plain object: only own properties are slots, otherwise
  // {{constructor}}/{{hasownproperty}} would resolve to Object.prototype members.
  const lookup = (key: string): string | undefined =>
    Object.hasOwn(vars, key) ? vars[key] : undefined;
  let out = template;
  for (let prev; prev !== out;) {
    prev = out;
    out = out.replaceAll(
      /\{\{#if ([a-z]+)\}\}((?:(?!\{\{#if )[\s\S])*?)\{\{\/if\}\}/gi,
      (_, key: string, body: string) => (lookup(key.toLowerCase())?.trim() ? body : ''),
    );
  }
  out = out.replaceAll(
    /\{\{([a-z]+)\}\}/gi,
    (match, key: string) => lookup(key.toLowerCase()) ?? match,
  );
  return out.replaceAll(/\n{3,}/g, '\n\n').trim();
}

export interface BuiltPrompt {
  messages: ChatMessage[];
  /** "Name:" to prefill the assistant turn with, when the template prefixes speaker names. */
  namePrefill: string | null;
  /** {{char}}/{{user}} as this prompt resolved them (persona honors usesPersonas). */
  charName: string;
  userName: string;
}

/**
 * Assembles the upstream chat completion messages: the system message rendered
 * from the (user-editable) prompt template, then the active-path history.
 * `speakerName` is the name the reply being generated was stamped with
 * (defaults to the conversation's current speaker).
 */
export function buildChatMessages(
  conversation: Conversation,
  history: Message[],
  speakerName: string | null = conversation.speakerName,
): BuiltPrompt {
  const character = getCharacter(conversation.characterId);
  const settings = getSettings();

  // Character-specific inline template wins, then the character's template
  // reference, then the global default, then the built-in. An inline template
  // carries the same settings a template entity has.
  const custom = character?.customTemplate ?? null;
  const template = custom
    ? null
    : (getTemplate(character?.templateId ?? null) ?? getTemplate(settings.defaultTemplateId));

  // A template can opt the chat out of personas entirely: {{user}} becomes
  // "User" and the persona description slot renders empty.
  const usesPersonas = custom ? custom.usesPersonas : (template?.usesPersonas ?? true);
  const persona = usesPersonas ? getPersona(conversation.personaId) : null;
  const charName = character?.name ?? 'Assistant';
  const userName = persona?.name ?? 'User';
  const sub = (text: string) => substituteMacros(text.trim(), charName, userName);

  const systemPrompt =
    character?.customPrompt ??
    getPresetContent(character?.presetId ?? null) ??
    getPresetContent(settings.defaultPresetId) ??
    '';
  const vars = {
    system: sub(systemPrompt),
    personality: sub(character?.personality ?? ''),
    persona: sub(persona?.description ?? ''),
    scenario: sub(character?.scenario ?? ''),
    char: charName,
    user: userName,
  };
  const systemContent = renderTemplate(
    (custom ? custom.content.trim() : template?.content.trim()) || DEFAULT_PROMPT_TEMPLATE,
    vars,
  );
  // Optional fake first user message (e.g. introducing the character); empty = not emitted.
  const prologueSource = custom ? custom.userPrologue : (template?.userPrologue ?? '');
  const prologue = prologueSource.trim() ? renderTemplate(prologueSource, vars) : '';

  const prefixNames = custom ? custom.prefixNames : (template?.prefixNames ?? false);
  const speakerFor = (msg: Message) =>
    msg.role === 'user' ? userName : msg.name?.trim() || charName;

  const messages: ChatMessage[] = [];
  if (systemContent) messages.push({ role: 'system', content: systemContent });
  if (prologue) messages.push({ role: 'user', content: prologue });
  for (const msg of history) {
    if (msg.status === 'streaming') continue;
    if (msg.role === 'tool') continue; // plugin output is chat-visible only, never sent upstream
    const trimmedContent = msg.content.trim();
    if (trimmedContent.length === 0) continue;
    // Stored history only ever carries user/assistant (tool is skipped above),
    // so every prefixed message has a speaker.
    const content = prefixNames ? `${speakerFor(msg).trim()}: ${trimmedContent}` : trimmedContent;
    messages.push({ role: msg.role, content });
  }

  const currentSpeaker = speakerName?.trim() || charName;
  return { messages, namePrefill: prefixNames ? `${currentSpeaker}:` : null, charName, userName };
}

/**
 * Upstream request for a plugin tool generation: the normal chat context plus
 * the tool's prompt (macros expanded) as a trailing user turn. No name
 * prefill — tool output is not a character reply.
 */
export function buildToolPrompt(
  conversation: Conversation,
  history: Message[],
  prompt: string,
): BuiltPrompt {
  const built = buildChatMessages(conversation, history);
  built.messages.push({
    role: 'user',
    content: substituteMacros(prompt.trim(), built.charName, built.userName),
  });
  return { ...built, namePrefill: null };
}

/**
 * Upstream request for a steered regeneration: the normal chat context (built
 * for the name the new sibling speaks with) plus the rendered steer text as a
 * trailing system message. The steer lives only in this prompt — it is never
 * stored on a message, so later generations are unaffected.
 */
export function buildSteeredPrompt(
  conversation: Conversation,
  history: Message[],
  steer: string,
  speakerName: string | null,
): BuiltPrompt {
  const built = buildChatMessages(conversation, history, speakerName);
  built.messages.push({ role: 'system', content: steer });
  return built;
}
