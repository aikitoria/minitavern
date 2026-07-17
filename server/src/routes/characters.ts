import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AVATAR_DIR, db, toCharacter } from '../db.ts';
import { invalidate } from '../events.ts';
import { buildCharacterCard, makePlaceholderPng, parseCharacterCard } from '../pngCard.ts';
import { route, HttpError } from '../router.ts';
import {
  objectBody,
  optionalNullableId,
  optionalNullableString,
  optionalString,
  positiveId,
  requiredString,
} from '../validation.ts';
import type { Ctx } from '../router.ts';
import { deleteAvatarFiles, saveAvatar } from './avatarStore.ts';
import { optionalName, requireReference, rowById, rows } from './entityUtils.ts';
import { discardSpeculativeSwipes } from '../speculation.ts';

route.get('/api/characters', () => rows('characters').map(toCharacter));

route.post('/api/characters', ({ body }) => {
  const b = objectBody(body);
  const presetId = optionalNullableId(b, 'presetId') ?? null;
  const templateId = optionalNullableId(b, 'templateId') ?? null;
  requireReference('presets', presetId, 'presetId');
  requireReference('templates', templateId, 'templateId');
  const result = db
    .prepare(
      `INSERT INTO characters (name, personality, scenario, first_message, preset_id, custom_prompt, template_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      requiredString(b, 'name'),
      optionalString(b, 'personality') ?? '',
      optionalString(b, 'scenario') ?? '',
      optionalString(b, 'firstMessage') ?? '',
      presetId,
      optionalNullableString(b, 'customPrompt') ?? null,
      templateId,
      Date.now(),
    );
  invalidate('characters');
  return toCharacter(rowById('characters', Number(result.lastInsertRowid)));
});

route.patch('/api/characters/:id', ({ params, body }) => {
  const id = positiveId(params.id);
  const cur = toCharacter(rowById('characters', id));
  const b = objectBody(body);
  const presetId = optionalNullableId(b, 'presetId');
  const templateId = optionalNullableId(b, 'templateId');
  const customPrompt = optionalNullableString(b, 'customPrompt');
  requireReference('presets', presetId, 'presetId');
  requireReference('templates', templateId, 'templateId');
  db.prepare(
    `UPDATE characters SET name = ?, personality = ?, scenario = ?, first_message = ?,
     preset_id = ?, custom_prompt = ?, template_id = ? WHERE id = ?`,
  ).run(
    optionalName(optionalString(b, 'name'), cur.name),
    optionalString(b, 'personality') ?? cur.personality,
    optionalString(b, 'scenario') ?? cur.scenario,
    optionalString(b, 'firstMessage') ?? cur.firstMessage,
    presetId === undefined ? cur.presetId : presetId,
    customPrompt === undefined ? cur.customPrompt : customPrompt,
    templateId === undefined ? cur.templateId : templateId,
    id,
  );
  invalidate('characters');
  discardSpeculativeSwipes();
  return toCharacter(rowById('characters', id));
});

route.del('/api/characters/:id', ({ params }) => {
  const id = positiveId(params.id);
  rowById('characters', id);
  db.prepare('DELETE FROM characters WHERE id = ?').run(id);
  discardSpeculativeSwipes();
  deleteAvatarFiles('character', id);
  invalidate('characters');
  invalidate('conversations');
});

route.put(
  '/api/characters/:id/avatar',
  ({ params, raw, req }: Ctx) => {
    const id = positiveId(params.id);
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
    let card: ReturnType<typeof parseCharacterCard>;
    try {
      card = parseCharacterCard(raw);
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : 'invalid character card');
    }
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
    let avatar: string;
    try {
      avatar = saveAvatar('character', id, raw, 'image/png');
    } catch (err) {
      db.prepare('DELETE FROM characters WHERE id = ?').run(id);
      throw err;
    }
    db.prepare('UPDATE characters SET avatar = ? WHERE id = ?').run(avatar, id);
    invalidate('characters');
    return toCharacter(rowById('characters', id));
  },
  { rawBody: true },
);

/** Export a character as a SillyTavern-compatible V2 PNG card. */
route.get('/api/characters/:id/card', ({ params, res }) => {
  const id = positiveId(params.id);
  const row = rowById('characters', id);
  const character = toCharacter(row);
  const original = row.card_json
    ? (JSON.parse(row.card_json as string) as { data?: Record<string, unknown> })
    : null;
  const card = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      ...(original?.data ?? {}),
      name: character.name,
      description: character.personality,
      personality: '',
      scenario: character.scenario,
      first_mes: character.firstMessage,
      system_prompt: character.customPrompt ?? original?.data?.system_prompt ?? '',
    },
  };
  let base: Buffer | null = null;
  try {
    base = readFileSync(join(AVATAR_DIR, `character-${id}.png`));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const png = buildCharacterCard(base ?? makePlaceholderPng(), card);
  res
    .writeHead(200, {
      'content-type': 'image/png',
      'content-disposition': `attachment; filename="${character.name.replace(/[^\w.-]+/g, '_')}.card.png"`,
      'content-length': png.length,
    })
    .end(png);
});
