import type { Settings } from '@minitavern/shared';
import { DEFAULT_SETTINGS } from '@minitavern/shared';
import { route } from '../router.ts';
import { getSettings, putSettings } from '../settingsStore.ts';
import { invalidate } from '../events.ts';

route.get('/api/settings', () => getSettings());

route.put('/api/settings', ({ body }) => {
  const next: Settings = { ...DEFAULT_SETTINGS, ...getSettings(), ...(body as Partial<Settings>) };
  putSettings(next);
  invalidate('settings');
  return next;
});
