import { db, toPreset } from '../db.ts';
import { invalidate } from '../events.ts';
import { route } from '../router.ts';
import { clearSettingReference } from '../settingsStore.ts';
import { objectBody, optionalString, positiveId, requiredString } from '../validation.ts';
import { optionalName, rowById, rows } from './entityUtils.ts';
import { discardSpeculativeSwipes } from '../speculation.ts';

route.get('/api/presets', () => rows('presets').map(toPreset));

route.post('/api/presets', ({ body }) => {
  const b = objectBody(body);
  const result = db
    .prepare('INSERT INTO presets (name, content, created_at) VALUES (?, ?, ?)')
    .run(requiredString(b, 'name'), optionalString(b, 'content') ?? '', Date.now());
  invalidate('presets');
  return toPreset(rowById('presets', Number(result.lastInsertRowid)));
});

route.patch('/api/presets/:id', ({ params, body }) => {
  const id = positiveId(params.id);
  const cur = toPreset(rowById('presets', id));
  const b = objectBody(body);
  db.prepare('UPDATE presets SET name = ?, content = ? WHERE id = ?').run(
    optionalName(optionalString(b, 'name'), cur.name),
    optionalString(b, 'content') ?? cur.content,
    id,
  );
  invalidate('presets');
  discardSpeculativeSwipes();
  return toPreset(rowById('presets', id));
});

route.del('/api/presets/:id', ({ params }) => {
  const id = positiveId(params.id);
  rowById('presets', id);
  db.prepare('DELETE FROM presets WHERE id = ?').run(id);
  discardSpeculativeSwipes();
  invalidate('presets');
  invalidate('characters');
  if (clearSettingReference('defaultPresetId', id)) invalidate('settings');
});
