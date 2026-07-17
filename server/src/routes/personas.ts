import { db, toPersona } from '../db.ts';
import { invalidate } from '../events.ts';
import { route, HttpError } from '../router.ts';
import { clearSettingReference } from '../settingsStore.ts';
import { objectBody, optionalString, positiveId, requiredString } from '../validation.ts';
import type { Ctx } from '../router.ts';
import { deleteAvatarFiles, saveAvatar } from './avatarStore.ts';
import { optionalName, rowById, rows } from './entityUtils.ts';
import { discardSpeculativeSwipes } from '../speculation.ts';

route.get('/api/personas', () => rows('personas').map(toPersona));

route.post('/api/personas', ({ body }) => {
  const b = objectBody(body);
  const result = db
    .prepare('INSERT INTO personas (name, description, created_at) VALUES (?, ?, ?)')
    .run(requiredString(b, 'name'), optionalString(b, 'description') ?? '', Date.now());
  invalidate('personas');
  return toPersona(rowById('personas', Number(result.lastInsertRowid)));
});

route.patch('/api/personas/:id', ({ params, body }) => {
  const id = positiveId(params.id);
  const cur = toPersona(rowById('personas', id));
  const b = objectBody(body);
  db.prepare('UPDATE personas SET name = ?, description = ? WHERE id = ?').run(
    optionalName(optionalString(b, 'name'), cur.name),
    optionalString(b, 'description') ?? cur.description,
    id,
  );
  invalidate('personas');
  discardSpeculativeSwipes();
  return toPersona(rowById('personas', id));
});

route.del('/api/personas/:id', ({ params }) => {
  const id = positiveId(params.id);
  rowById('personas', id);
  db.prepare('DELETE FROM personas WHERE id = ?').run(id);
  discardSpeculativeSwipes();
  deleteAvatarFiles('persona', id);
  invalidate('personas');
  invalidate('conversations');
  if (clearSettingReference('defaultPersonaId', id)) invalidate('settings');
});

route.put(
  '/api/personas/:id/avatar',
  ({ params, raw, req }: Ctx) => {
    const id = positiveId(params.id);
    rowById('personas', id);
    if (!raw?.length) throw new HttpError(400, 'image body is required');
    const avatar = saveAvatar('persona', id, raw, req.headers['content-type'] ?? '');
    db.prepare('UPDATE personas SET avatar = ? WHERE id = ?').run(avatar, id);
    invalidate('personas');
    return toPersona(rowById('personas', id));
  },
  { rawBody: true },
);
