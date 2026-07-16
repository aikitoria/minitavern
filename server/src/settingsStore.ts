import type { Settings } from '@minitavern/shared';
import { DEFAULT_SETTINGS } from '@minitavern/shared';
import { db } from './db.ts';

export function getSettings(): Settings {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('app') as
    | { value: string }
    | undefined;
  return row ? { ...DEFAULT_SETTINGS, ...JSON.parse(row.value) } : { ...DEFAULT_SETTINGS };
}

export function putSettings(settings: Settings): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    'app',
    JSON.stringify(settings),
  );
}
