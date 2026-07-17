import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Character } from '@minitavern/shared';
import { AVATAR_DIR, stmt, toCharacter } from '../db.ts';
import { invalidate } from '../events.ts';
import { buildCharacterCard, makePlaceholderPng, parseCharacterCard } from '../pngCard.ts';
import { route, HttpError } from '../router.ts';
import type { Ctx } from '../router.ts';
import { positiveId } from '../validation.ts';
import { deleteAvatarFiles, saveAvatar } from './avatarStore.ts';
import {
  defineEntityRoutes,
  nameField,
  nullableTextField,
  refIdField,
  textField,
} from './entityRoutes.ts';
import { rowById } from './entityUtils.ts';

defineEntityRoutes<Character>({
  table: 'characters',
  toDto: toCharacter,
  fields: [
    nameField((cur) => cur.name),
    textField('personality', 'personality', (cur) => cur.personality),
    textField('scenario', 'scenario', (cur) => cur.scenario),
    textField('firstMessage', 'first_message', (cur) => cur.firstMessage),
    refIdField('presetId', 'preset_id', 'presets', (cur) => cur.presetId),
    nullableTextField('customPrompt', 'custom_prompt', (cur) => cur.customPrompt),
    refIdField('templateId', 'template_id', 'templates', (cur) => cur.templateId),
  ],
  invalidateOnDelete: ['conversations'],
  onDelete: (id) => deleteAvatarFiles('character', id),
});

route.put(
  '/api/characters/:id/avatar',
  ({ params, raw, req }: Ctx) => {
    const id = positiveId(params.id);
    rowById('characters', id);
    if (!raw?.length) throw new HttpError(400, 'image body is required');
    const avatar = saveAvatar('character', id, raw, req.headers['content-type'] ?? '');
    stmt('UPDATE characters SET avatar = ? WHERE id = ?').run(avatar, id);
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
    const result = stmt(
      `INSERT INTO characters (name, personality, scenario, first_message, custom_prompt, card_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
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
      stmt('DELETE FROM characters WHERE id = ?').run(id);
      throw err;
    }
    stmt('UPDATE characters SET avatar = ? WHERE id = ?').run(avatar, id);
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
