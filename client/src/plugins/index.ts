import type { Message } from '@minitavern/shared';
import type { Plugin, PluginCommand, PluginMessageView, PluginTool } from './api.ts';
import { imageGenerationPlugin } from './imageGeneration.tsx';

/** All installed plugins; add new ones here. */
export const PLUGINS: Plugin[] = [imageGenerationPlugin];

export const pluginTools: PluginTool[] = PLUGINS.flatMap((plugin) => plugin.tools ?? []);
export const pluginCommands: PluginCommand[] = PLUGINS.flatMap((plugin) => plugin.commands ?? []);

/** The message view of the first plugin claiming this tool message, if any. */
export function findMessageView(message: Message): PluginMessageView | undefined {
  return PLUGINS.find((plugin) => plugin.messageView?.claims(message))?.messageView;
}
