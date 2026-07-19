import type { Settings } from '@minitavern/shared';
import { DEFAULT_SETTINGS } from '@minitavern/shared';
import { route, HttpError } from '../router.ts';
import { getSettings, putSettings } from '../settingsStore.ts';
import { invalidate } from '../events.ts';
import { requireReference, type EntityTable } from './entityUtils.ts';
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
  const tables: Record<keyof typeof ids, EntityTable> = {
    defaultPresetId: 'presets',
    activeEndpointId: 'endpoints',
    defaultPersonaId: 'personas',
    defaultTemplateId: 'templates',
  };
  for (const key of Object.keys(ids) as (keyof typeof ids)[]) {
    requireReference(tables[key], ids[key], key);
  }
  const autoExpandThinking = optionalBoolean(b, 'autoExpandThinking');
  const backgroundSwipeGeneration = optionalBoolean(b, 'backgroundSwipeGeneration');
  const pluginSettings = b.pluginSettings as Settings['pluginSettings'] | undefined;
  if (pluginSettings !== undefined) {
    const isPlainObject = (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v);
    if (!isPlainObject(pluginSettings) || !Object.values(pluginSettings).every(isPlainObject)) {
      throw new HttpError(400, 'pluginSettings must be an object of per-plugin objects');
    }
  }
  const next: Settings = {
    ...DEFAULT_SETTINGS,
    ...current,
    ...Object.fromEntries(Object.entries(ids).filter(([, value]) => value !== undefined)),
    ...(autoExpandThinking === undefined ? {} : { autoExpandThinking }),
    ...(backgroundSwipeGeneration === undefined ? {} : { backgroundSwipeGeneration }),
    ...(pluginSettings === undefined ? {} : { pluginSettings }),
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
