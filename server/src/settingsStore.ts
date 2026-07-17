import type { Settings } from '@minitavern/shared';
import { DEFAULT_SETTINGS } from '@minitavern/shared';
import { db } from './db.ts';

export function getSettings(): Settings {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('app') as
    { value: string } | undefined;
  return row ? { ...DEFAULT_SETTINGS, ...JSON.parse(row.value) } : { ...DEFAULT_SETTINGS };
}

export function putSettings(settings: Settings): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run('app', JSON.stringify(settings));
}

type SettingsReferenceKey = Exclude<
  keyof Settings,
  'revision' | 'autoExpandThinking' | 'backgroundSwipeGeneration'
>;

export function clearSettingReference(key: SettingsReferenceKey, id: number): boolean {
  const settings = getSettings();
  if (settings[key] !== id) return false;
  putSettings({ ...settings, [key]: null, revision: settings.revision + 1 });
  return true;
}
