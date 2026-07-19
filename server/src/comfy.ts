import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { workflowValidationError } from '@minitavern/shared';
import { stmt } from './db.ts';
import { getMessage, markMessageDirty } from './tree.ts';
import { broadcastTree } from './sync.ts';
import { broadcastConv } from './events.ts';
import { deleteImageFiles, saveImage } from './images.ts';

/**
 * ComfyUI render pipeline for tool generations: expand {{prompt}}/{{seed}}
 * into the workflow (API format), submit, relay per-step progress to the
 * conversation's subscribers, download the output image, store it under
 * /images/ and attach it to the message. The message shows image='pending'
 * from submission until the file lands (or the placeholder clears on error).
 */

const RENDER_TIMEOUT_MS = 5 * 60_000;
/** Render poll interval; e2e runs (E2E_BASE is set) default to a fast cadence. */
const POLL_INTERVAL_MS = Number(process.env.COMFY_POLL_MS ?? (process.env.E2E_BASE ? 100 : 1500));
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;

export interface RenderJob {
  conversationId: number;
  mid: number;
  comfyUrl: string;
  /** Workflow JSON template with {{prompt}}/{{seed}} slots. */
  workflow: string;
  /** The generated image description substituted into {{prompt}}. */
  description: string;
}

/** {{prompt}} is JSON-string-escaped (it sits inside a quoted workflow value);
 * {{seed}} becomes a random integer literal. Single pass, so macro-shaped
 * text inside the substituted description is never rescanned. */
function expandWorkflow(workflow: string, description: string): string {
  const escaped = JSON.stringify(description).slice(1, -1);
  const seed = String(Math.floor(Math.random() * 0xffff_ffff));
  return workflow.replaceAll(/\{\{(prompt|seed)\}\}/gi, (_, key: string) =>
    key.toLowerCase() === 'prompt' ? escaped : seed,
  );
}

/** Validates and normalizes a route-supplied image render config. The
 * workflow check is the shared route-time/save-time validator, so a broken
 * workflow 400s here instead of failing async mid-render. */
export function parseImageConfig(raw: unknown): { workflow: string; comfyUrl: string } {
  const obj =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const workflow = typeof obj.workflow === 'string' ? obj.workflow : '';
  if (!workflow.trim()) throw new Error('image.workflow is required');
  const invalid = workflowValidationError(workflow);
  if (invalid) throw new Error(`image.workflow ${invalid}`);
  const comfyUrl =
    typeof obj.comfyUrl === 'string' && obj.comfyUrl.trim()
      ? obj.comfyUrl.trim()
      : 'http://comfy:8588';
  return { workflow, comfyUrl };
}

interface ComfyOutputFile {
  filename: string;
  subfolder: string;
  type: string;
}

interface ComfyHistoryEntry {
  status?: {
    status_str?: string;
    completed?: boolean;
    /** [kind, payload] tuples; execution_error payloads carry node tracebacks. */
    messages?: [string, Record<string, unknown>][];
  };
  outputs?: Record<string, { images?: ComfyOutputFile[]; gifs?: ComfyOutputFile[] }>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Best-effort progress socket; rendering works without it (polling drives completion). */
export function openProgressSocket(
  base: string,
  clientId: string,
  onProgress: (value: number, max: number) => void,
): Promise<WebSocket | null> {
  return new Promise((resolve) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws?clientId=${clientId}`);
    } catch {
      resolve(null);
      return;
    }
    // A handshake slower than the settle window must not leak the socket:
    // once we resolve null, nobody owns it — kill it if it opens late.
    let settled = false;
    const settle = setTimeout(() => {
      settled = true;
      resolve(null);
    }, 2000);
    ws.on('open', () => {
      if (settled) {
        ws.terminate();
        return;
      }
      clearTimeout(settle);
      resolve(ws);
    });
    ws.on('error', () => {
      clearTimeout(settle);
      resolve(null);
    });
    ws.on('message', (raw) => {
      try {
        const ev = JSON.parse(String(raw)) as {
          type?: string;
          data?: { value?: number; max?: number };
        };
        if (ev.type === 'progress' && typeof ev.data?.value === 'number' && ev.data.max) {
          onProgress(ev.data.value, ev.data.max);
        }
      } catch {
        /* Binary preview frames and malformed events are ignored. */
      }
    });
  });
}

/** The message-independent render request: expand the workflow, submit to
 * ComfyUI, poll to completion and download the preferred output file. */
export interface RenderRequest {
  comfyUrl: string;
  /** Workflow JSON template with {{prompt}}/{{seed}} slots. */
  workflow: string;
  /** The text substituted into {{prompt}}. */
  prompt: string;
  /** Correlates ComfyUI progress events with a caller-owned progress socket. */
  clientId?: string;
}

/** Renders a workflow and returns the raw output image — no message
 * persistence, no broadcasts (used by the avatar generator). */
export async function renderToBuffer(
  request: RenderRequest,
): Promise<{ ext: string; data: Buffer; promptId: string }> {
  if (!request.prompt.trim()) throw new Error('empty image description');
  const workflowObj: unknown = JSON.parse(expandWorkflow(request.workflow, request.prompt));
  const base = request.comfyUrl.replace(/\/+$/, '');
  const clientId = request.clientId ?? randomUUID();
  const submit = await fetch(`${base}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: workflowObj, client_id: clientId }),
    signal: AbortSignal.timeout(30_000),
  }).catch((err: unknown) => {
    // Node's bare "fetch failed" hides the interesting part (ENOTFOUND, ECONNREFUSED, …).
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    throw new Error(
      `ComfyUI unreachable at ${base}: ${cause?.code ?? cause?.message ?? (err instanceof Error ? err.message : String(err))}`,
    );
  });
  if (!submit.ok) {
    const text = await submit.text().catch(() => '');
    throw new Error(`ComfyUI rejected the workflow (${submit.status}): ${text.slice(0, 300)}`);
  }
  const { prompt_id: promptId } = (await submit.json()) as { prompt_id: string };
  if (!promptId) throw new Error('ComfyUI returned no prompt id');

  const deadline = Date.now() + RENDER_TIMEOUT_MS;
  let outputs: ComfyHistoryEntry['outputs'];
  while (!outputs) {
    if (Date.now() > deadline) throw new Error('ComfyUI render timed out');
    await sleep(POLL_INTERVAL_MS);
    const res = await fetch(`${base}/history/${promptId}`, {
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (!res?.ok) continue;
    const history = (await res.json()) as Record<string, ComfyHistoryEntry>;
    const entry = history[promptId];
    if (!entry) continue;
    if (entry.status?.status_str === 'error') {
      // Surface node tracebacks (à la SillyTavern) instead of a bare failure.
      const details = (entry.status.messages ?? [])
        .filter((message) => message[0] === 'execution_error')
        .map((message) => message[1])
        .map((d) => `${d.node_type} [${d.node_id}] ${d.exception_type}: ${d.exception_message}`)
        .join('; ');
      throw new Error(`ComfyUI workflow execution failed${details ? `: ${details}` : ''}`);
    }
    if (entry.outputs && Object.keys(entry.outputs).length > 0) outputs = entry.outputs;
    // A workflow with no output node completes with empty outputs — fail
    // fast instead of polling out the whole timeout.
    else if (entry.status?.completed) throw new Error('ComfyUI produced no output image');
  }

  // Prefer a saved output; fall back to previews/temp and animated outputs
  // so preview-only workflows still produce something.
  const files = Object.values(outputs).flatMap((node) => [
    ...(node.images ?? []),
    ...(node.gifs ?? []),
  ]);
  const image = files.find((file) => file.type === 'output') ?? files[0];
  if (!image) throw new Error('ComfyUI produced no output image');

  const params = new URLSearchParams({
    filename: image.filename,
    subfolder: image.subfolder,
    type: image.type,
  });
  const download = await fetch(`${base}/view?${params}`, { signal: AbortSignal.timeout(60_000) });
  if (!download.ok) throw new Error(`failed to download image (${download.status})`);
  // Cap the download: /view is server-controlled output, but a huge (or
  // content-length-less) response must not balloon memory/disk.
  const declared = Number(download.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
    throw new Error(`rendered image exceeds the ${MAX_IMAGE_BYTES / 1024 / 1024} MB limit`);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of download.body!) {
    size += chunk.byteLength;
    if (size > MAX_IMAGE_BYTES) {
      throw new Error(`rendered image exceeds the ${MAX_IMAGE_BYTES / 1024 / 1024} MB limit`);
    }
    chunks.push(Buffer.from(chunk));
  }
  const data = Buffer.concat(chunks);

  const ext = image.filename.includes('.')
    ? image.filename.slice(image.filename.lastIndexOf('.'))
    : '.png';
  return { ext, data, promptId };
}

/** Message-bound render: ComfyUI progress is relayed to subscribers and the
 * output file is persisted onto the message as a new selected alternative. */
async function render(job: RenderJob): Promise<void> {
  const base = job.comfyUrl.replace(/\/+$/, '');
  const clientId = randomUUID();
  const ws = await openProgressSocket(base, clientId, (value, max) =>
    broadcastConv(job.conversationId, {
      t: 'imageProgress',
      conversationId: job.conversationId,
      mid: job.mid,
      value,
      max,
    }),
  );
  try {
    const { ext, data, promptId } = await renderToBuffer({
      comfyUrl: job.comfyUrl,
      workflow: job.workflow,
      prompt: job.description,
      clientId,
    });
    const url = saveImage(`msg-${job.mid}-${promptId.slice(0, 8)}${ext}`, data);
    // Append as a new image alternative and select it; a cleared pending flag
    // means the message was deleted (or reset) mid-render — discard the file.
    const row = stmt(
      'SELECT images_json, gen_meta_json FROM messages WHERE id = ? AND image_pending = 1',
    ).get(job.mid) as { images_json: string; gen_meta_json: string | null } | undefined;
    if (!row) {
      deleteImageFiles([url]);
      return;
    }
    const images = [...(JSON.parse(row.images_json) as string[]), url];
    // A successful render clears any previous imageError (retry succeeded).
    const meta = row.gen_meta_json
      ? (JSON.parse(row.gen_meta_json) as Record<string, unknown>)
      : null;
    if (meta) delete meta.imageError;
    stmt(
      'UPDATE messages SET images_json = ?, active_image = ?, image_pending = 0, gen_meta_json = ? WHERE id = ?',
    ).run(JSON.stringify(images), images.length - 1, meta ? JSON.stringify(meta) : null, job.mid);
    markMessageDirty(job.conversationId, job.mid);
    broadcastTree(job.conversationId);
  } finally {
    ws?.close();
  }
}

/** Fire-and-forget: failures clear the pending flag and surface as genMeta.imageError. */
export function startImageRender(job: RenderJob): void {
  render(job).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[comfy] render failed for message ${job.mid}: ${message}`);
    const row = getMessage(job.mid);
    if (!row) return;
    const meta = JSON.stringify({ ...(row.genMeta ?? {}), imageError: message });
    stmt(
      'UPDATE messages SET image_pending = 0, gen_meta_json = ? WHERE id = ? AND image_pending = 1',
    ).run(meta, job.mid);
    markMessageDirty(job.conversationId, job.mid);
    broadcastTree(job.conversationId);
  });
}
