import type { Template } from '@minitavern/shared';
import { toTemplate } from '../db.ts';
import { optionalBoolean } from '../validation.ts';
import { defineEntityRoutes, nameField, textField } from './entityRoutes.ts';

defineEntityRoutes<Template>({
  table: 'templates',
  toDto: toTemplate,
  fields: [
    nameField((cur) => cur.name),
    textField('content', 'content', (cur) => cur.content),
    textField('userPrologue', 'user_prologue', (cur) => cur.userPrologue),
    {
      column: 'prefix_names',
      value: (b, cur) => ((optionalBoolean(b, 'prefixNames') ?? cur?.prefixNames ?? false) ? 1 : 0),
    },
  ],
  settingsRef: 'defaultTemplateId',
  invalidateOnDelete: ['characters'],
});
