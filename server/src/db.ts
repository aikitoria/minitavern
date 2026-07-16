import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  Character,
  Conversation,
  Endpoint,
  Message,
  Persona,
  Preset,
  Template,
} from '@minitavern/shared';
import { DEFAULT_PROMPT_TEMPLATE, DEFAULT_SETTINGS } from '@minitavern/shared';

export const DATA_DIR = process.env.DATA_DIR ?? '/data';
export const AVATAR_DIR = join(DATA_DIR, 'avatars');
const DB_PATH = process.env.DB_PATH ?? join(DATA_DIR, 'minitavern.db');

mkdirSync(dirname(DB_PATH), { recursive: true });
mkdirSync(AVATAR_DIR, { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON');

// Schema migrations (DDL + seeds only). Settings that move between scopes are
// not carried over — they reset to defaults and get re-picked in the UI.
const { user_version: version } = db.prepare('PRAGMA user_version').get() as {
  user_version: number;
};

if (version < 1) {
  db.exec(`
    BEGIN;
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE presets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE personas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      avatar TEXT,
      description TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE endpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      api_key TEXT NOT NULL DEFAULT '',
      models_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE characters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      avatar TEXT,
      personality TEXT NOT NULL DEFAULT '',
      scenario TEXT NOT NULL DEFAULT '',
      first_message TEXT NOT NULL DEFAULT '',
      preset_id INTEGER REFERENCES presets(id) ON DELETE SET NULL,
      custom_prompt TEXT,
      card_json TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      character_id INTEGER REFERENCES characters(id) ON DELETE SET NULL,
      persona_id INTEGER REFERENCES personas(id) ON DELETE SET NULL,
      endpoint_id INTEGER REFERENCES endpoints(id) ON DELETE SET NULL,
      model TEXT,
      gen_params_json TEXT NOT NULL DEFAULT '{}',
      active_leaf_id INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      parent_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      reasoning TEXT,
      status TEXT NOT NULL DEFAULT 'done',
      active_child_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
      model TEXT,
      gen_meta_json TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_messages_conversation ON messages(conversation_id);
    CREATE INDEX idx_messages_parent ON messages(parent_id);
    PRAGMA user_version = 1;
    COMMIT;
  `);
  const now = Date.now();
  db.prepare('INSERT INTO presets (name, content, created_at) VALUES (?, ?, ?)').run(
    'Default assistant',
    'You are {{char}}, a helpful assistant talking to {{user}}. Answer accurately and concisely.',
    now,
  );
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
    'app',
    JSON.stringify({ ...DEFAULT_SETTINGS, defaultPresetId: 1, defaultTemplateId: 1 }),
  );
}

if (version < 2) {
  db.exec(`
    BEGIN;
    CREATE TABLE templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    PRAGMA user_version = 2;
    COMMIT;
  `);
  db.prepare('INSERT INTO templates (name, content, created_at) VALUES (?, ?, ?)').run(
    'Default',
    DEFAULT_PROMPT_TEMPLATE,
    Date.now(),
  );
}

if (version < 3) {
  db.exec(`
    BEGIN;
    ALTER TABLE templates ADD COLUMN user_prologue TEXT NOT NULL DEFAULT '';
    ALTER TABLE characters ADD COLUMN template_id INTEGER REFERENCES templates(id) ON DELETE SET NULL;
    PRAGMA user_version = 3;
    COMMIT;
  `);
}

if (version < 4) {
  db.exec(`
    BEGIN;
    ALTER TABLE conversations ADD COLUMN speaker_name TEXT;
    ALTER TABLE messages ADD COLUMN name TEXT;
    ALTER TABLE templates ADD COLUMN prefix_names INTEGER NOT NULL DEFAULT 0;
    PRAGMA user_version = 4;
    COMMIT;
  `);
}

if (version < 5) {
  db.exec(`
    BEGIN;
    ALTER TABLE endpoints ADD COLUMN gen_params_json TEXT NOT NULL DEFAULT '{}';
    PRAGMA user_version = 5;
    COMMIT;
  `);
}

if (version < 6) {
  db.exec(`
    BEGIN;
    ALTER TABLE endpoints ADD COLUMN model TEXT;
    PRAGMA user_version = 6;
    COMMIT;
  `);
}

// Generations don't survive a restart: finalize any rows a previous process left streaming.
db.prepare(
  `UPDATE messages SET status = 'error',
   gen_meta_json = json_object('error', 'Server restarted during generation') WHERE status = 'streaming'`,
).run();

let txDepth = 0;

/** Nestable: only the outermost call opens/commits; an inner throw rolls back everything. */
export function transaction<T>(fn: () => T): T {
  if (txDepth > 0) {
    txDepth++;
    try {
      return fn();
    } finally {
      txDepth--;
    }
  }
  txDepth = 1;
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    txDepth = 0;
  }
}

type Row = Record<string, unknown>;

export function toMessage(r: Row): Message {
  return {
    id: r.id as number,
    conversationId: r.conversation_id as number,
    parentId: r.parent_id as number | null,
    role: r.role as Message['role'],
    content: r.content as string,
    reasoning: r.reasoning as string | null,
    name: r.name as string | null,
    status: r.status as Message['status'],
    activeChildId: r.active_child_id as number | null,
    model: r.model as string | null,
    genMeta: r.gen_meta_json ? JSON.parse(r.gen_meta_json as string) : null,
    createdAt: r.created_at as number,
  };
}

export function toConversation(r: Row): Conversation {
  return {
    id: r.id as number,
    title: r.title as string,
    characterId: r.character_id as number | null,
    personaId: r.persona_id as number | null,
    speakerName: r.speaker_name as string | null,
    activeLeafId: r.active_leaf_id as number | null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

export function toCharacter(r: Row): Character {
  return {
    id: r.id as number,
    name: r.name as string,
    avatar: r.avatar as string | null,
    personality: r.personality as string,
    scenario: r.scenario as string,
    firstMessage: r.first_message as string,
    presetId: r.preset_id as number | null,
    customPrompt: r.custom_prompt as string | null,
    templateId: r.template_id as number | null,
    createdAt: r.created_at as number,
  };
}

export function toPreset(r: Row): Preset {
  return {
    id: r.id as number,
    name: r.name as string,
    content: r.content as string,
    createdAt: r.created_at as number,
  };
}

export function toTemplate(r: Row): Template {
  return {
    id: r.id as number,
    name: r.name as string,
    content: r.content as string,
    userPrologue: r.user_prologue as string,
    prefixNames: (r.prefix_names as number) !== 0,
    createdAt: r.created_at as number,
  };
}

export function toPersona(r: Row): Persona {
  return {
    id: r.id as number,
    name: r.name as string,
    avatar: r.avatar as string | null,
    description: r.description as string,
    createdAt: r.created_at as number,
  };
}

export function toEndpoint(r: Row): Endpoint {
  return {
    id: r.id as number,
    name: r.name as string,
    baseUrl: r.base_url as string,
    apiKey: r.api_key as string,
    models: JSON.parse(r.models_json as string),
    model: r.model as string | null,
    genParams: JSON.parse(r.gen_params_json as string),
    createdAt: r.created_at as number,
  };
}
