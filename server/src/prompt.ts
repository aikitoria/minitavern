import type { Character, Conversation, Message, Persona, Role, Template } from '@minitavern/shared';
import { DEFAULT_PROMPT_TEMPLATE } from '@minitavern/shared';
import { stmt, toCharacter, toPersona, toPreset, toTemplate } from './db.ts';
import { getSettings } from './settingsStore.ts';

export interface ChatMessage {
  role: Role;
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
  let out = template.replaceAll(
    /\{\{#if ([a-z]+)\}\}([\s\S]*?)\{\{\/if\}\}/gi,
    (_, key: string, body: string) => (vars[key.toLowerCase()]?.trim() ? body : ''),
  );
  out = out.replaceAll(
    /\{\{([a-z]+)\}\}/gi,
    (match, key: string) => vars[key.toLowerCase()] ?? match,
  );
  return out.replaceAll(/\n{3,}/g, '\n\n').trim();
}

export interface BuiltPrompt {
  messages: ChatMessage[];
  /** "Name:" to prefill the assistant turn with, when the template prefixes speaker names. */
  namePrefill: string | null;
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
  const persona = getPersona(conversation.personaId);
  const settings = getSettings();
  const charName = character?.name ?? 'Assistant';
  const userName = persona?.name ?? 'User';
  const sub = (text: string) => substituteMacros(text.trim(), charName, userName);

  const systemPrompt =
    character?.customPrompt ??
    getPresetContent(character?.presetId ?? null) ??
    getPresetContent(settings.defaultPresetId) ??
    '';

  // Character-specific template wins over the global default, then the built-in.
  const template =
    getTemplate(character?.templateId ?? null) ?? getTemplate(settings.defaultTemplateId);
  const vars = {
    system: sub(systemPrompt),
    personality: sub(character?.personality ?? ''),
    persona: sub(persona?.description ?? ''),
    scenario: sub(character?.scenario ?? ''),
    char: charName,
    user: userName,
  };
  const systemContent = renderTemplate(template?.content.trim() || DEFAULT_PROMPT_TEMPLATE, vars);
  // Optional fake first user message (e.g. introducing the character); empty = not emitted.
  const prologue = template?.userPrologue.trim() ? renderTemplate(template.userPrologue, vars) : '';

  const prefixNames = template?.prefixNames ?? false;
  const speakerFor = (msg: Message) =>
    msg.role === 'user' ? userName : msg.name?.trim() || charName;

  const messages: ChatMessage[] = [];
  if (systemContent) messages.push({ role: 'system', content: systemContent });
  if (prologue) messages.push({ role: 'user', content: prologue });
  for (const msg of history) {
    if (msg.status === 'streaming') continue;
    const trimmedContent = msg.content.trim();
    if (trimmedContent.length === 0) continue;
    const content =
      prefixNames && msg.role !== 'system'
        ? `${speakerFor(msg).trim()}: ${trimmedContent}`
        : trimmedContent;
    messages.push({ role: msg.role, content });
  }

  const currentSpeaker = speakerName?.trim() || charName;
  return { messages, namePrefill: prefixNames ? `${currentSpeaker}:` : null };
}
