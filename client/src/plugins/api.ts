import type { Component, JSX } from 'solid-js';
import { api } from '../state/api.ts';
import { setState, state } from '../state/store.ts';

/** A button in the composer's tools menu. */
export interface PluginTool {
  label: string;
  icon: () => JSX.Element;
  run: () => void;
}

/** A composer slash command (same contract as the built-ins). */
export interface PluginCommand {
  name: string;
  params: string;
  description: string;
  /** Return false to keep the composer text (e.g. validation failed upstream). */
  run: (args: string) => Promise<boolean | void>;
}

/**
 * A client-side plugin: contributes any combination of tools-menu buttons,
 * slash commands, and a page in the Tools settings tab. Settings persist in
 * the global Settings under pluginSettings[id] (revision-guarded like the
 * rest, synced across devices via the settings invalidate).
 */
export interface Plugin {
  /** Key into settings.pluginSettings; never rename once shipped. */
  id: string;
  /** Name shown in the Tools settings list. */
  name: string;
  tools?: PluginTool[];
  commands?: PluginCommand[];
  settingsPage?: Component;
}

/** Current settings for a plugin, with defaults filled in (reactive). */
export function pluginSettings<T extends Record<string, unknown>>(id: string, defaults: T): T {
  return { ...defaults, ...(state.settings.pluginSettings[id] as Partial<T> | undefined) };
}

/** Persists one plugin's settings blob under the global revision guard. */
export async function savePluginSettings(
  id: string,
  values: Record<string, unknown>,
): Promise<void> {
  const next = await api.putSettings(
    { pluginSettings: { ...state.settings.pluginSettings, [id]: values } },
    state.settings.revision,
  );
  setState('settings', next);
}
