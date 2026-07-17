import type { Conversation, GenMeta, Message } from '@minitavern/shared';
import { stmt, toEndpoint } from './db.ts';
import { getMessage, getPathToMessage } from './tree.ts';
import { buildChatMessages } from './prompt.ts';
import { getSettings } from './settingsStore.ts';
import { broadcastConv, invalidate } from './events.ts';

interface ActiveGen {
  mid: number;
  conversationId: number;
  content: string;
  reasoning: string;
  /** Unknown (null) until run() resolves the active endpoint. */
  model: string | null;
  abort: AbortController;
  flushTimer: NodeJS.Timeout;
  meta: GenMeta;
  background: boolean;
  /** New tokens since the last periodic DB flush. */
  dirty: boolean;
  onDone?: () => void;
  onError?: () => void;
}

const active = new Map<number, ActiveGen>();

export function hasActiveGeneration(conversationId: number): boolean {
  for (const gen of active.values()) if (gen.conversationId === conversationId) return true;
  return false;
}

export function hasForegroundGeneration(conversationId: number): boolean {
  for (const gen of active.values()) {
    if (gen.conversationId === conversationId && !gen.background) return true;
  }
  return false;
}

export function isBackgroundGeneration(mid: number): boolean {
  return active.get(mid)?.background === true;
}

/** Marks a speculative stream as foreground once the user activates it. */
export function promoteBackgroundGeneration(mid: number): boolean {
  const gen = active.get(mid);
  if (!gen?.background) return false;
  gen.background = false;
  stmt("UPDATE messages SET generation_kind = 'normal' WHERE id = ?").run(mid);
  return true;
}

/** Stops the conversation's speculative generation, if any, and returns its message id. */
export function stopBackgroundGeneration(conversationId: number): number | null {
  const gen = [...active.values()].find(
    (candidate) => candidate.conversationId === conversationId && candidate.background,
  );
  if (!gen) return null;
  stopGeneration(gen.mid);
  return gen.mid;
}

/** Used when the global setting is disabled. */
export function stopAllBackgroundGenerations(): { mid: number; conversationId: number }[] {
  const stopped: { mid: number; conversationId: number }[] = [];
  for (const gen of [...active.values()]) {
    if (!gen.background) continue;
    stopped.push({ mid: gen.mid, conversationId: gen.conversationId });
    stopGeneration(gen.mid);
  }
  return stopped;
}

/** Overlays in-flight stream buffers onto persisted rows so snapshots are current. */
export function mergeLiveBuffers(messages: Message[]): Message[] {
  if (active.size === 0) return messages;
  return messages.map((m) => {
    const gen = active.get(m.id);
    if (!gen) return m;
    return {
      ...m,
      content: gen.content,
      reasoning: gen.reasoning || m.reasoning,
      model: gen.model,
    };
  });
}

function flushToDb(gen: ActiveGen): void {
  if (!gen.dirty) return;
  gen.dirty = false;
  stmt('UPDATE messages SET content = ?, reasoning = ?, model = ? WHERE id = ?').run(
    gen.content,
    gen.reasoning || null,
    gen.model,
    gen.mid,
  );
}

function finalize(gen: ActiveGen, status: 'done' | 'error' | 'stopped'): void {
  // Identity check, not just key presence: `continue` reuses the message id,
  // so a late abort from a stopped generation must not touch its successor.
  if (active.get(gen.mid) !== gen) return;
  active.delete(gen.mid);
  clearInterval(gen.flushTimer);
  gen.content = gen.content.trim();
  gen.reasoning = gen.reasoning.trim();
  // The message may have been deleted mid-stream (cascade or explicit delete).
  const exists = stmt('SELECT id FROM messages WHERE id = ?').get(gen.mid);
  if (exists) {
    stmt(
      'UPDATE messages SET content = ?, reasoning = ?, model = ?, status = ?, gen_meta_json = ? WHERE id = ?',
    ).run(gen.content, gen.reasoning || null, gen.model, status, JSON.stringify(gen.meta), gen.mid);
    broadcastConv(gen.conversationId, {
      t: 'final',
      conversationId: gen.conversationId,
      message: getMessage(gen.mid)!,
    });
  }
  invalidate('conversations');
  if (status === 'done' && gen.onDone) {
    queueMicrotask(() => {
      try {
        gen.onDone?.();
      } catch (err) {
        console.error('[generation] completion callback failed:', err);
      }
    });
  }
  if (status === 'error' && gen.onError) {
    queueMicrotask(() => {
      try {
        gen.onError?.();
      } catch (err) {
        console.error('[generation] error callback failed:', err);
      }
    });
  }
}

export function stopGeneration(mid: number): boolean {
  const gen = active.get(mid);
  if (!gen) return false;
  gen.abort.abort();
  finalize(gen, 'stopped');
  return true;
}

export function stopConversationGenerations(conversationId: number): void {
  for (const gen of [...active.values()]) {
    if (gen.conversationId === conversationId) {
      gen.abort.abort();
      finalize(gen, 'stopped');
    }
  }
}

interface SseDelta {
  content?: string;
  reasoning_content?: string;
  reasoning?: string;
}

/**
 * Starts streaming an assistant response into the (status='streaming')
 * message `mid`. Server-owned: independent of any client connection. Every
 * upstream delta is forwarded immediately over WS; the DB gets periodic
 * flushes plus a final write.
 *
 * With `resumeFrom`, the existing content is kept and sent upstream as a
 * trailing assistant message (prefill-style continue); new tokens append.
 */
export function startGeneration(
  conversation: Conversation,
  mid: number,
  resumeFrom?: { content: string; reasoning: string },
  options?: { background?: boolean; onDone?: () => void; onError?: () => void },
): void {
  const gen: ActiveGen = {
    mid,
    conversationId: conversation.id,
    content: resumeFrom?.content ?? '',
    reasoning: resumeFrom?.reasoning ?? '',
    model: null,
    abort: new AbortController(),
    flushTimer: setInterval(() => flushToDb(gen), 500),
    meta: {},
    background: options?.background ?? false,
    dirty: false,
    onDone: options?.onDone,
    onError: options?.onError,
  };
  active.set(mid, gen);
  run(conversation, gen, resumeFrom != null).catch((err: unknown) => {
    if (active.get(mid) !== gen) return; // already stopped/finalized (or superseded by a resume)
    // May already carry a specific message (e.g. idle timeout).
    gen.meta.error ??= err instanceof Error ? err.message : String(err);
    finalize(gen, 'error');
  });
}

/** A wedged backend must not leave a message spinning forever. */
const IDLE_TIMEOUT_MS = 120_000;

async function run(conversation: Conversation, gen: ActiveGen, isResume: boolean): Promise<void> {
  const settings = getSettings();
  const endpointRow = settings.activeEndpointId
    ? (stmt('SELECT * FROM endpoints WHERE id = ?').get(settings.activeEndpointId) as
        Record<string, unknown> | undefined)
    : undefined;
  if (!endpointRow) {
    throw new Error('No active endpoint — pick one in Settings → General');
  }
  const endpoint = toEndpoint(endpointRow);
  if (!endpoint.model) {
    throw new Error(
      `Endpoint "${endpoint.name}" has no model selected — set one in Settings → Endpoints`,
    );
  }
  gen.model = endpoint.model;

  // A reply is based on its ancestors, not whichever sibling happens to be active.
  // This matters for speculative siblings, which deliberately stay inactive.
  const target = getMessage(gen.mid);
  const history = getPathToMessage(target?.parentId ?? null);
  // The reply speaks as the name it was stamped with (regenerations keep their sibling's name).
  const stampedName = getMessage(gen.mid)?.name ?? null;
  const { messages, namePrefill } = buildChatMessages(conversation, history, stampedName);
  // Prefill-style trailing assistant message (resume content and/or "Name:").
  // Not part of the official OpenAI spec — with prefillMode 'none' the
  // backend decides; 'vllm'/'deepseek' send their native continuation flags.
  let prefilled = false;
  if (isResume && gen.content) {
    messages.push({
      role: 'assistant',
      content: namePrefill ? `${namePrefill} ${gen.content}` : gen.content,
    });
    prefilled = true;
  } else if (namePrefill) {
    messages.push({ role: 'assistant', content: namePrefill });
    prefilled = true;
  }
  const upstreamMessages: Record<string, unknown>[] = messages.map((m) => ({ ...m }));
  if (prefilled && endpoint.prefillMode === 'deepseek') {
    upstreamMessages[upstreamMessages.length - 1] = {
      ...upstreamMessages[upstreamMessages.length - 1],
      prefix: true,
    };
  }
  const p = endpoint.genParams;

  // Idle watchdog: abort if the backend goes silent (including before headers).
  const onIdle = () => {
    gen.meta.error = `Upstream idle timeout — no data received for ${IDLE_TIMEOUT_MS / 1000}s`;
    gen.abort.abort();
  };
  let idleTimer = setTimeout(onIdle, IDLE_TIMEOUT_MS);
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(onIdle, IDLE_TIMEOUT_MS);
  };

  try {
    const res = await fetch(`${endpoint.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: endpoint.model,
        messages: upstreamMessages,
        stream: true,
        ...(p.temperature != null ? { temperature: p.temperature } : {}),
        ...(p.topP != null ? { top_p: p.topP } : {}),
        ...(p.maxTokens != null ? { max_tokens: p.maxTokens } : {}),
        ...(p.frequencyPenalty != null ? { frequency_penalty: p.frequencyPenalty } : {}),
        ...(p.presencePenalty != null ? { presence_penalty: p.presencePenalty } : {}),
        ...(prefilled && endpoint.prefillMode === 'vllm'
          ? { continue_final_message: true, add_generation_prompt: false }
          : {}),
      }),
      signal: gen.abort.signal,
    });
    resetIdle();

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new Error(`Upstream error ${res.status}: ${text.slice(0, 500)}`);
    }
    await consumeStream(res.body, gen, namePrefill, isResume, resetIdle);
  } finally {
    clearTimeout(idleTimer);
  }
}

async function consumeStream(
  body: NonNullable<Awaited<ReturnType<typeof fetch>>['body']>,
  gen: ActiveGen,
  namePrefill: string | null,
  isResume: boolean,
  resetIdle: () => void,
): Promise<void> {
  // Backends without real prefill support tend to echo the "Name:" prefix at
  // the start of their reply; hold back the first characters and strip it.
  let holdback: string | null = namePrefill && !isResume ? '' : null;
  const passContent = (d: string): string => {
    if (holdback == null) return d;
    holdback += d;
    const probe = holdback.trimStart();
    const target = namePrefill!;
    if (probe.length < target.length && target.toLowerCase().startsWith(probe.toLowerCase())) {
      return ''; // still ambiguous, keep holding
    }
    const out = probe.toLowerCase().startsWith(target.toLowerCase())
      ? probe.slice(target.length).replace(/^[ \t]+/, '')
      : holdback;
    holdback = null;
    return out;
  };

  const decoder = new TextDecoder();
  let buffer = '';
  const processLine = (rawLine: string): void => {
    const line = rawLine.replace(/\r$/, '');
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let parsed: {
      choices?: { delta?: SseDelta; finish_reason?: string | null }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
    };
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const choice = parsed.choices?.[0];
    const delta = choice?.delta;
    const d = delta?.content ?? undefined;
    const r = delta?.reasoning_content ?? delta?.reasoning ?? undefined;
    if (choice?.finish_reason) gen.meta.finishReason = choice.finish_reason;
    if (parsed.usage) {
      gen.meta.usage = {
        promptTokens: parsed.usage.prompt_tokens,
        completionTokens: parsed.usage.completion_tokens,
      };
    }
    if (d == null && r == null) return;
    const dOut = d != null ? passContent(d) : '';
    if (dOut) gen.content += dOut;
    if (r) gen.reasoning += r;
    if (dOut || r) gen.dirty = true;
    if (active.get(gen.mid) !== gen || (!dOut && !r)) return;
    // Latency first: forward each delta the moment it arrives.
    broadcastConv(gen.conversationId, {
      t: 'delta',
      mid: gen.mid,
      ...(dOut ? { d: dOut } : {}),
      ...(r ? { r } : {}),
    });
  };
  for await (const chunk of body) {
    resetIdle();
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      processLine(line);
      if (active.get(gen.mid) !== gen) return; // stopped while iterating
    }
  }
  buffer += decoder.decode();
  if (buffer) {
    for (const line of buffer.split('\n')) processLine(line);
  }
  // A reply shorter than the name prefix may still be held back — flush it.
  if (holdback?.trim() && active.get(gen.mid) === gen) {
    gen.content += holdback;
    broadcastConv(gen.conversationId, { t: 'delta', mid: gen.mid, d: holdback });
  }
  finalize(gen, 'done'); // no-op if already stopped/superseded
}
