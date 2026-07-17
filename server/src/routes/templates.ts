import { db, toTemplate } from '../db.ts';
import { invalidate } from '../events.ts';
import { route } from '../router.ts';
import { clearSettingReference } from '../settingsStore.ts';
import {
  objectBody,
  optionalBoolean,
  optionalString,
  positiveId,
  requiredString,
} from '../validation.ts';
import { optionalName, rowById, rows } from './entityUtils.ts';
import { discardSpeculativeSwipes } from '../speculation.ts';

route.get('/api/templates', () => rows('templates').map(toTemplate));

route.post('/api/templates', ({ body }) => {
  const b = objectBody(body);
  const result = db
    .prepare(
      'INSERT INTO templates (name, content, user_prologue, prefix_names, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(
      requiredString(b, 'name'),
      optionalString(b, 'content') ?? '',
      optionalString(b, 'userPrologue') ?? '',
      optionalBoolean(b, 'prefixNames') ? 1 : 0,
      Date.now(),
    );
  invalidate('templates');
  return toTemplate(rowById('templates', Number(result.lastInsertRowid)));
});

route.patch('/api/templates/:id', ({ params, body }) => {
  const id = positiveId(params.id);
  const cur = toTemplate(rowById('templates', id));
  const b = objectBody(body);
  const prefixNames = optionalBoolean(b, 'prefixNames');
  db.prepare(
    'UPDATE templates SET name = ?, content = ?, user_prologue = ?, prefix_names = ? WHERE id = ?',
  ).run(
    optionalName(optionalString(b, 'name'), cur.name),
    optionalString(b, 'content') ?? cur.content,
    optionalString(b, 'userPrologue') ?? cur.userPrologue,
    (prefixNames ?? cur.prefixNames) ? 1 : 0,
    id,
  );
  invalidate('templates');
  discardSpeculativeSwipes();
  return toTemplate(rowById('templates', id));
});

route.del('/api/templates/:id', ({ params }) => {
  const id = positiveId(params.id);
  rowById('templates', id);
  db.prepare('DELETE FROM templates WHERE id = ?').run(id);
  discardSpeculativeSwipes();
  invalidate('templates');
  invalidate('characters');
  if (clearSettingReference('defaultTemplateId', id)) invalidate('settings');
});
