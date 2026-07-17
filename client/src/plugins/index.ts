import type { Plugin, PluginCommand, PluginTool } from './api.ts';
import { imageGenerationPlugin } from './imageGeneration.tsx';

/** All installed plugins; add new ones here. */
export const PLUGINS: Plugin[] = [imageGenerationPlugin];

export const pluginTools: PluginTool[] = PLUGINS.flatMap((plugin) => plugin.tools ?? []);
export const pluginCommands: PluginCommand[] = PLUGINS.flatMap((plugin) => plugin.commands ?? []);
