import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { GenParams } from '@minitavern/shared';
import { AVATAR_DIR, db, toCharacter, toEndpoint, toPersona, toPreset, toTemplate } from '../db.ts';
import { route, HttpError } from '../router.ts';
import { invalidate } from '../events.ts';
import { parseCharacterCard } from '../pngCard.ts';
import type { Ctx } from '../router.ts';

function rows(sql: string): Record<string, unknown>[] {
  return db.prepare(sql).all() as Record<string, unknown>[];
}

function rowById(table: string, id: number): Record<string, unknown> {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as
    Record<string, unknown> | undefined;
  if (!row) throw new HttpError(404, `${table.slice(0, -1)} ${id} not found`);
  return row;
}

const IMAGE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

function saveAvatar(
  kind: 'character' | 'persona',
  id: number,
  data: Buffer,
  contentType: string,
): string {
  const ext = IMAGE_EXT[contentType];
  if (!ext) throw new HttpError(415, 'avatar must be image/png, image/jpeg or image/webp');
  const filename = `${kind}-${id}.${ext}`;
  writeFileSync(join(AVATAR_DIR, filename), data);
  return `/avatars/${filename}?v=${Date.now()}`;
}

function deleteAvatarFiles(kind: 'character' | 'persona', id: number): void {
  for (const ext of Object.values(IMAGE_EXT)) {
    try {
      unlinkSync(join(AVATAR_DIR, `${kind}-${id}.${ext}`));
    } catch {
      /* not present */
    }
  }
}

// ---- Presets ----

route.get('/api/presets', () => rows('SELECT * FROM presets ORDER BY id').map(toPreset));

route.post('/api/presets', ({ body }) => {
  const b = (body ?? {}) as { name?: string; content?: string };
  if (!b.name?.trim()) throw new HttpError(400, 'name is required');
  const result = db
    .prepare('INSERT INTO presets (name, content, created_at) VALUES (?, ?, ?)')
    .run(b.name.trim(), b.content ?? '', Date.now());
  invalidate('presets');
  return toPreset(rowById('presets', Number(result.lastInsertRowid)));
});

route.patch('/api/presets/:id', ({ params, body }) => {
  const id = Number(params.id);
  const cur = toPreset(rowById('presets', id));
  const b = (body ?? {}) as Partial<{ name: string; content: string }>;
  db.prepare('UPDATE presets SET name = ?, content = ? WHERE id = ?').run(
    b.name ?? cur.name,
    b.content ?? cur.content,
    id,
  );
  invalidate('presets');
  return toPreset(rowById('presets', id));
});

route.del('/api/presets/:id', ({ params }) => {
  const id = Number(params.id);
  rowById('presets', id);
  db.prepare('DELETE FROM presets WHERE id = ?').run(id);
  invalidate('presets');
  invalidate('characters');
});

// ---- Prompt templates ----

route.get('/api/templates', () => rows('SELECT * FROM templates ORDER BY id').map(toTemplate));

route.post('/api/templates', ({ body }) => {
  const b = (body ?? {}) as {
    name?: string;
    content?: string;
    userPrologue?: string;
    prefixNames?: boolean;
  };
  if (!b.name?.trim()) throw new HttpError(400, 'name is required');
  const result = db
    .prepare(
      'INSERT INTO templates (name, content, user_prologue, prefix_names, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(b.name.trim(), b.content ?? '', b.userPrologue ?? '', b.prefixNames ? 1 : 0, Date.now());
  invalidate('templates');
  return toTemplate(rowById('templates', Number(result.lastInsertRowid)));
});

route.patch('/api/templates/:id', ({ params, body }) => {
  const id = Number(params.id);
  const cur = toTemplate(rowById('templates', id));
  const b = (body ?? {}) as Partial<{
    name: string;
    content: string;
    userPrologue: string;
    prefixNames: boolean;
  }>;
  db.prepare(
    'UPDATE templates SET name = ?, content = ?, user_prologue = ?, prefix_names = ? WHERE id = ?',
  ).run(
    b.name ?? cur.name,
    b.content ?? cur.content,
    b.userPrologue ?? cur.userPrologue,
    (b.prefixNames ?? cur.prefixNames) ? 1 : 0,
    id,
  );
  invalidate('templates');
  return toTemplate(rowById('templates', id));
});

route.del('/api/templates/:id', ({ params }) => {
  const id = Number(params.id);
  rowById('templates', id);
  db.prepare('DELETE FROM templates WHERE id = ?').run(id);
  invalidate('templates');
});

// ---- Personas ----

route.get('/api/personas', () => rows('SELECT * FROM personas ORDER BY id').map(toPersona));

route.post('/api/personas', ({ body }) => {
  const b = (body ?? {}) as { name?: string; description?: string };
  if (!b.name?.trim()) throw new HttpError(400, 'name is required');
  const result = db
    .prepare('INSERT INTO personas (name, description, created_at) VALUES (?, ?, ?)')
    .run(b.name.trim(), b.description ?? '', Date.now());
  invalidate('personas');
  return toPersona(rowById('personas', Number(result.lastInsertRowid)));
});

route.patch('/api/personas/:id', ({ params, body }) => {
  const id = Number(params.id);
  const cur = toPersona(rowById('personas', id));
  const b = (body ?? {}) as Partial<{ name: string; description: string }>;
  db.prepare('UPDATE personas SET name = ?, description = ? WHERE id = ?').run(
    b.name ?? cur.name,
    b.description ?? cur.description,
    id,
  );
  invalidate('personas');
  return toPersona(rowById('personas', id));
});

route.del('/api/personas/:id', ({ params }) => {
  const id = Number(params.id);
  rowById('personas', id);
  db.prepare('DELETE FROM personas WHERE id = ?').run(id);
  deleteAvatarFiles('persona', id);
  invalidate('personas');
});

route.put(
  '/api/personas/:id/avatar',
  ({ params, raw, req }: Ctx) => {
    const id = Number(params.id);
    rowById('personas', id);
    if (!raw?.length) throw new HttpError(400, 'image body is required');
    const avatar = saveAvatar('persona', id, raw, req.headers['content-type'] ?? '');
    db.prepare('UPDATE personas SET avatar = ? WHERE id = ?').run(avatar, id);
    invalidate('personas');
    return toPersona(rowById('personas', id));
  },
  { rawBody: true },
);

// ---- Characters ----

route.get('/api/characters', () => rows('SELECT * FROM characters ORDER BY id').map(toCharacter));

route.post('/api/characters', ({ body }) => {
  const b = (body ?? {}) as Partial<{
    name: string;
    personality: string;
    scenario: string;
    firstMessage: string;
    presetId: number | null;
    customPrompt: string | null;
    templateId: number | null;
  }>;
  if (!b.name?.trim()) throw new HttpError(400, 'name is required');
  const result = db
    .prepare(
      `INSERT INTO characters (name, personality, scenario, first_message, preset_id, custom_prompt, template_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      b.name.trim(),
      b.personality ?? '',
      b.scenario ?? '',
      b.firstMessage ?? '',
      b.presetId ?? null,
      b.customPrompt ?? null,
      b.templateId ?? null,
      Date.now(),
    );
  invalidate('characters');
  return toCharacter(rowById('characters', Number(result.lastInsertRowid)));
});

route.patch('/api/characters/:id', ({ params, body }) => {
  const id = Number(params.id);
  const cur = toCharacter(rowById('characters', id));
  const b = (body ?? {}) as Partial<{
    name: string;
    personality: string;
    scenario: string;
    firstMessage: string;
    presetId: number | null;
    customPrompt: string | null;
    templateId: number | null;
  }>;
  db.prepare(
    `UPDATE characters SET name = ?, personality = ?, scenario = ?, first_message = ?,
     preset_id = ?, custom_prompt = ?, template_id = ? WHERE id = ?`,
  ).run(
    b.name ?? cur.name,
    b.personality ?? cur.personality,
    b.scenario ?? cur.scenario,
    b.firstMessage ?? cur.firstMessage,
    b.presetId !== undefined ? b.presetId : cur.presetId,
    b.customPrompt !== undefined ? b.customPrompt : cur.customPrompt,
    b.templateId !== undefined ? b.templateId : cur.templateId,
    id,
  );
  invalidate('characters');
  return toCharacter(rowById('characters', id));
});

route.del('/api/characters/:id', ({ params }) => {
  const id = Number(params.id);
  rowById('characters', id);
  db.prepare('DELETE FROM characters WHERE id = ?').run(id);
  deleteAvatarFiles('character', id);
  invalidate('characters');
  invalidate('conversations');
});

route.put(
  '/api/characters/:id/avatar',
  ({ params, raw, req }: Ctx) => {
    const id = Number(params.id);
    rowById('characters', id);
    if (!raw?.length) throw new HttpError(400, 'image body is required');
    const avatar = saveAvatar('character', id, raw, req.headers['content-type'] ?? '');
    db.prepare('UPDATE characters SET avatar = ? WHERE id = ?').run(avatar, id);
    invalidate('characters');
    return toCharacter(rowById('characters', id));
  },
  { rawBody: true },
);

route.post(
  '/api/characters/import-card',
  ({ raw }: Ctx) => {
    if (!raw?.length) throw new HttpError(400, 'PNG body is required');
    const card = parseCharacterCard(raw);
    const result = db
      .prepare(
        `INSERT INTO characters (name, personality, scenario, first_message, custom_prompt, card_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        card.name,
        card.personality,
        card.scenario,
        card.firstMessage,
        card.systemPrompt,
        JSON.stringify(card.raw),
        Date.now(),
      );
    const id = Number(result.lastInsertRowid);
    const avatar = saveAvatar('character', id, raw, 'image/png');
    db.prepare('UPDATE characters SET avatar = ? WHERE id = ?').run(avatar, id);
    invalidate('characters');
    return toCharacter(rowById('characters', id));
  },
  { rawBody: true },
);

// ---- Endpoints ----

route.get('/api/endpoints', () => rows('SELECT * FROM endpoints ORDER BY id').map(toEndpoint));

route.post('/api/endpoints', ({ body }) => {
  const b = (body ?? {}) as Partial<{
    name: string;
    baseUrl: string;
    apiKey: string;
    model: string | null;
    genParams: GenParams;
  }>;
  if (!b.name?.trim()) throw new HttpError(400, 'name is required');
  if (!b.baseUrl?.trim()) throw new HttpError(400, 'baseUrl is required');
  const result = db
    .prepare(
      'INSERT INTO endpoints (name, base_url, api_key, model, gen_params_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(
      b.name.trim(),
      b.baseUrl.trim().replace(/\/+$/, ''),
      b.apiKey ?? '',
      b.model ?? null,
      JSON.stringify(b.genParams ?? {}),
      Date.now(),
    );
  invalidate('endpoints');
  return toEndpoint(rowById('endpoints', Number(result.lastInsertRowid)));
});

route.patch('/api/endpoints/:id', ({ params, body }) => {
  const id = Number(params.id);
  const cur = toEndpoint(rowById('endpoints', id));
  const b = (body ?? {}) as Partial<{
    name: string;
    baseUrl: string;
    apiKey: string;
    model: string | null;
    genParams: GenParams;
  }>;
  db.prepare(
    'UPDATE endpoints SET name = ?, base_url = ?, api_key = ?, model = ?, gen_params_json = ? WHERE id = ?',
  ).run(
    b.name ?? cur.name,
    (b.baseUrl ?? cur.baseUrl).replace(/\/+$/, ''),
    b.apiKey ?? cur.apiKey,
    b.model !== undefined ? b.model : cur.model,
    JSON.stringify(b.genParams ?? cur.genParams),
    id,
  );
  invalidate('endpoints');
  return toEndpoint(rowById('endpoints', id));
});

route.del('/api/endpoints/:id', ({ params }) => {
  const id = Number(params.id);
  rowById('endpoints', id);
  db.prepare('DELETE FROM endpoints WHERE id = ?').run(id);
  invalidate('endpoints');
  invalidate('conversations');
});

route.get('/api/endpoints/:id/models', async ({ params }) => {
  const endpoint = toEndpoint(rowById('endpoints', Number(params.id)));
  const res = await fetch(`${endpoint.baseUrl}/models`, {
    headers: endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {},
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new HttpError(502, `upstream /models returned ${res.status}`);
  const json = (await res.json()) as { data?: { id?: string }[] };
  const models = (json.data ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === 'string')
    .sort();
  db.prepare('UPDATE endpoints SET models_json = ? WHERE id = ?').run(
    JSON.stringify(models),
    endpoint.id,
  );
  invalidate('endpoints');
  return models;
});
