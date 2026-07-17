import type { Endpoint, GenParams } from '@minitavern/shared';
import { stmt, toEndpoint } from '../db.ts';
import { invalidate } from '../events.ts';
import { route, HttpError } from '../router.ts';
import { objectBody, optionalNumber, optionalString, positiveId } from '../validation.ts';
import { defineEntityRoutes, nameField, nullableTextField } from './entityRoutes.ts';
import { rowById } from './entityUtils.ts';

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

defineEntityRoutes<Endpoint>({
  table: 'endpoints',
  toDto: toEndpoint,
  toPublic: publicEndpoint,
  fields: [
    nameField((cur) => cur.name),
    { column: 'base_url', value: (b, cur) => baseUrl(optionalString(b, 'baseUrl'), cur?.baseUrl) },
    { column: 'api_key', value: (b, cur) => optionalString(b, 'apiKey') ?? cur?.apiKey ?? '' },
    nullableTextField('model', 'model', (cur) => cur.model),
    {
      column: 'gen_params_json',
      value: (b, cur) => JSON.stringify(genParams(b.genParams, cur?.genParams)),
    },
    {
      column: 'prefill_mode',
      value: (b, cur) => prefillMode(b.prefillMode, cur?.prefillMode ?? 'none'),
    },
  ],
  settingsRef: 'activeEndpointId',
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
  stmt('UPDATE endpoints SET models_json = ? WHERE id = ?').run(
    JSON.stringify(models),
    endpoint.id,
  );
  invalidate('endpoints');
  return models;
});
