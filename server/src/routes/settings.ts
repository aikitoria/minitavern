import type { Settings } from '@minitavern/shared';
import { DEFAULT_SETTINGS } from '@minitavern/shared';
import { route, HttpError } from '../router.ts';
import { getSettings, putSettings } from '../settingsStore.ts';
import { invalidate } from '../events.ts';
import { db } from '../db.ts';
import { objectBody, optionalBoolean, optionalNullableId, optionalNumber } from '../validation.ts';
import { discardSpeculativeSwipes } from '../speculation.ts';
import { subscribedConversationIds } from '../events.ts';
import { prepareActiveSwipe } from './conversations.ts';

route.get('/api/settings', () => getSettings());

route.put('/api/settings', ({ body }) => {
  const b = objectBody(body);
  const current = getSettings();
  const expectedRevision = optionalNumber(b, 'expectedRevision');
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== current.revision) {
    invalidate('settings');
    throw new HttpError(409, 'global settings changed on another device; review and retry');
  }
  const ids = {
    defaultPresetId: optionalNullableId(b, 'defaultPresetId'),
    activeEndpointId: optionalNullableId(b, 'activeEndpointId'),
    defaultPersonaId: optionalNullableId(b, 'defaultPersonaId'),
    defaultTemplateId: optionalNullableId(b, 'defaultTemplateId'),
  };
  const tables: Record<keyof typeof ids, string> = {
    defaultPresetId: 'presets',
    activeEndpointId: 'endpoints',
    defaultPersonaId: 'personas',
    defaultTemplateId: 'templates',
  };
  for (const key of Object.keys(ids) as (keyof typeof ids)[]) {
    const id = ids[key];
    if (id != null && !db.prepare(`SELECT id FROM ${tables[key]} WHERE id = ?`).get(id)) {
      throw new HttpError(400, `${key} does not exist`);
    }
  }
  const autoExpandThinking = optionalBoolean(b, 'autoExpandThinking');
  const backgroundSwipeGeneration = optionalBoolean(b, 'backgroundSwipeGeneration');
  const next: Settings = {
    ...DEFAULT_SETTINGS,
    ...current,
    ...Object.fromEntries(Object.entries(ids).filter(([, value]) => value !== undefined)),
    ...(autoExpandThinking === undefined ? {} : { autoExpandThinking }),
    ...(backgroundSwipeGeneration === undefined ? {} : { backgroundSwipeGeneration }),
    revision: current.revision + 1,
  };
  putSettings(next);
  const generationContextChanged =
    current.activeEndpointId !== next.activeEndpointId ||
    current.defaultPresetId !== next.defaultPresetId ||
    current.defaultTemplateId !== next.defaultTemplateId;
  if (
    generationContextChanged ||
    (current.backgroundSwipeGeneration && !next.backgroundSwipeGeneration)
  ) {
    discardSpeculativeSwipes();
  }
  if (!current.backgroundSwipeGeneration && next.backgroundSwipeGeneration) {
    for (const conversationId of subscribedConversationIds()) prepareActiveSwipe(conversationId);
  }
  invalidate('settings');
  return next;
});
