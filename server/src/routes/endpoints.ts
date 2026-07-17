import type { Endpoint, GenParams } from '@minitavern/shared';
import { db, toEndpoint } from '../db.ts';
import { invalidate } from '../events.ts';
import { route, HttpError } from '../router.ts';
import { clearSettingReference } from '../settingsStore.ts';
import {
  objectBody,
  optionalNullableString,
  optionalNumber,
  optionalString,
  positiveId,
  requiredString,
} from '../validation.ts';
import { optionalName, rowById, rows } from './entityUtils.ts';
import { discardSpeculativeSwipes } from '../speculation.ts';

const PREFILL_MODES = new Set<Endpoint['prefillMode']>(['none', 'vllm', 'deepseek']);

function publicEndpoint(endpoint: Endpoint): Endpoint {
  return { ...endpoint, apiKey: '', hasApiKey: endpoint.apiKey.length > 0 };
}

function baseUrl(value: string | undefined, current?: string): string {
  const text = (value ?? current ?? '').trim().replace(/\/+$/, '');
  if (!text) throw new HttpError(400, 'baseUrl is required');
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new HttpError(400, 'baseUrl must be a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new HttpError(400, 'baseUrl must use http or https');
  }
  return text;
}

function genParams(value: unknown, current: GenParams = {}): GenParams {
  if (value === undefined) return current;
  const b = objectBody(value);
  const next: GenParams = {};
  const temperature = optionalNumber(b, 'temperature');
  const topP = optionalNumber(b, 'topP');
  const maxTokens = optionalNumber(b, 'maxTokens');
  const frequencyPenalty = optionalNumber(b, 'frequencyPenalty');
  const presencePenalty = optionalNumber(b, 'presencePenalty');
  if (temperature != null && (temperature < 0 || temperature > 2))
    throw new HttpError(400, 'temperature must be between 0 and 2');
  if (topP != null && (topP < 0 || topP > 1))
    throw new HttpError(400, 'topP must be between 0 and 1');
  if (maxTokens != null && (!Number.isInteger(maxTokens) || maxTokens < 1))
    throw new HttpError(400, 'maxTokens must be a positive integer');
  for (const [key, number] of [
    ['frequencyPenalty', frequencyPenalty],
    ['presencePenalty', presencePenalty],
  ] as const) {
    if (number != null && (number < -2 || number > 2)) {
      throw new HttpError(400, `${key} must be between -2 and 2`);
    }
  }
  if (temperature != null) next.temperature = temperature;
  if (topP != null) next.topP = topP;
  if (maxTokens != null) next.maxTokens = maxTokens;
  if (frequencyPenalty != null) next.frequencyPenalty = frequencyPenalty;
  if (presencePenalty != null) next.presencePenalty = presencePenalty;
  return next;
}

function prefillMode(value: unknown, current: Endpoint['prefillMode']): Endpoint['prefillMode'] {
  if (value === undefined) return current;
  if (typeof value !== 'string' || !PREFILL_MODES.has(value as Endpoint['prefillMode'])) {
    throw new HttpError(400, 'prefillMode must be none, vllm or deepseek');
  }
  return value as Endpoint['prefillMode'];
}

route.get('/api/endpoints', () => rows('endpoints').map(toEndpoint).map(publicEndpoint));

route.post('/api/endpoints', ({ body }) => {
  const b = objectBody(body);
  const result = db
    .prepare(
      'INSERT INTO endpoints (name, base_url, api_key, model, gen_params_json, prefill_mode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      requiredString(b, 'name'),
      baseUrl(requiredString(b, 'baseUrl')),
      optionalString(b, 'apiKey') ?? '',
      optionalNullableString(b, 'model') ?? null,
      JSON.stringify(genParams(b.genParams)),
      prefillMode(b.prefillMode, 'none'),
      Date.now(),
    );
  invalidate('endpoints');
  return publicEndpoint(toEndpoint(rowById('endpoints', Number(result.lastInsertRowid))));
});

route.patch('/api/endpoints/:id', ({ params, body }) => {
  const id = positiveId(params.id);
  const cur = toEndpoint(rowById('endpoints', id));
  const b = objectBody(body);
  const model = optionalNullableString(b, 'model');
  db.prepare(
    'UPDATE endpoints SET name = ?, base_url = ?, api_key = ?, model = ?, gen_params_json = ?, prefill_mode = ? WHERE id = ?',
  ).run(
    optionalName(optionalString(b, 'name'), cur.name),
    baseUrl(optionalString(b, 'baseUrl'), cur.baseUrl),
    optionalString(b, 'apiKey') ?? cur.apiKey,
    model === undefined ? cur.model : model,
    JSON.stringify(genParams(b.genParams, cur.genParams)),
    prefillMode(b.prefillMode, cur.prefillMode),
    id,
  );
  invalidate('endpoints');
  discardSpeculativeSwipes();
  return publicEndpoint(toEndpoint(rowById('endpoints', id)));
});

route.del('/api/endpoints/:id', ({ params }) => {
  const id = positiveId(params.id);
  rowById('endpoints', id);
  db.prepare('DELETE FROM endpoints WHERE id = ?').run(id);
  discardSpeculativeSwipes();
  invalidate('endpoints');
  if (clearSettingReference('activeEndpointId', id)) invalidate('settings');
});

route.get('/api/endpoints/:id/models', async ({ params }) => {
  const endpoint = toEndpoint(rowById('endpoints', positiveId(params.id)));
  let res: Response;
  try {
    res = await fetch(`${endpoint.baseUrl}/models`, {
      headers: endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {},
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new HttpError(
      502,
      `upstream /models failed: ${err instanceof Error ? err.message : err}`,
    );
  }
  if (!res.ok) throw new HttpError(502, `upstream /models returned ${res.status}`);
  const json = (await res.json()) as { data?: unknown };
  if (!Array.isArray(json.data)) throw new HttpError(502, 'upstream /models returned invalid JSON');
  const models = json.data
    .map((model) => (model && typeof model === 'object' ? (model as { id?: unknown }).id : null))
    .filter((id): id is string => typeof id === 'string')
    .sort();
  db.prepare('UPDATE endpoints SET models_json = ? WHERE id = ?').run(
    JSON.stringify(models),
    endpoint.id,
  );
  invalidate('endpoints');
  return models;
});
