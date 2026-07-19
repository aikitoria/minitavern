import { copyFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { IMAGES_DIR, stmt } from './db.ts';

/**
 * Generated-image files on disk. Every deletion path that can remove messages
 * (block splice, sibling-subtree cascade, delete-tail, conversation delete)
 * collects the doomed rows' image paths FIRST and unlinks them after the SQL
 * commit — SQLite FK cascades can't touch the filesystem. sweepOrphanedImages()
 * runs at startup as the backstop for crash windows.
 */

function imageFile(imagePath: string): string | null {
  if (!imagePath.startsWith('/images/')) return null;
  const name = basename(imagePath.slice('/images/'.length));
  return name ? join(IMAGES_DIR, name) : null;
}

export function saveImage(name: string, data: Buffer): string {
  writeFileSync(join(IMAGES_DIR, basename(name)), data);
  return `/images/${basename(name)}`;
}

/**
 * Copies a served image file under a new name (conversation duplication — two
 * message rows must never reference the same file, or hard-deleting one would
 * break the other). Returns the new served path, or null when the source file
 * is already missing (the reference was dangling before the copy).
 */
export function copyImage(imagePath: string, newName: string): string | null {
  const file = imageFile(imagePath);
  if (!file) return null;
  try {
    copyFileSync(file, join(IMAGES_DIR, basename(newName)));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  return `/images/${basename(newName)}`;
}

export function deleteImageFiles(imagePaths: string[]): void {
  for (const imagePath of imagePaths) {
    const file = imageFile(imagePath);
    if (!file) continue;
    try {
      unlinkSync(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`[images] failed to delete ${file}:`, err);
      }
    }
  }
}

/** All image paths of a single message. */
export function collectMessageImages(messageId: number): string[] {
  const rows = stmt(
    'SELECT j.value AS image FROM messages m, json_each(m.images_json) j WHERE m.id = ?',
  ).all(messageId) as { image: string }[];
  return rows.map((row) => row.image);
}

/** Image paths of a message's whole subtree (the rows a delete would cascade to). */
export function collectSubtreeImages(messageId: number): string[] {
  const rows = stmt(
    `WITH RECURSIVE doomed(id) AS (
       SELECT id FROM messages WHERE id = ?
       UNION ALL
       SELECT m.id FROM messages m JOIN doomed d ON m.parent_id = d.id
     )
     SELECT j.value AS image FROM messages m, json_each(m.images_json) j
     WHERE m.id IN (SELECT id FROM doomed)`,
  ).all(messageId) as { image: string }[];
  return rows.map((row) => row.image);
}

/** Image paths of the subtrees rooted at every child of `parentId` (delete-tail scope). */
export function collectSiblingSubtreeImages(
  conversationId: number,
  parentId: number | null,
): string[] {
  const rows = stmt(
    `WITH RECURSIVE doomed(id) AS (
       SELECT id FROM messages WHERE conversation_id = ? AND parent_id IS ?
       UNION ALL
       SELECT m.id FROM messages m JOIN doomed d ON m.parent_id = d.id
     )
     SELECT j.value AS image FROM messages m, json_each(m.images_json) j
     WHERE m.id IN (SELECT id FROM doomed)`,
  ).all(conversationId, parentId) as { image: string }[];
  return rows.map((row) => row.image);
}

/** All image paths in a conversation (conversation-delete scope). */
export function collectConversationImages(conversationId: number): string[] {
  const rows = stmt(
    'SELECT j.value AS image FROM messages m, json_each(m.images_json) j WHERE m.conversation_id = ?',
  ).all(conversationId) as { image: string }[];
  return rows.map((row) => row.image);
}

/** Startup backstop: delete files no message references (crash windows, late renders). */
export function sweepOrphanedImages(): void {
  const referenced = new Set(
    (
      stmt('SELECT j.value AS image FROM messages m, json_each(m.images_json) j').all() as {
        image: string;
      }[]
    )
      .map((row) => basename(row.image.slice('/images/'.length)))
      .filter(Boolean),
  );
  let removed = 0;
  for (const name of readdirSync(IMAGES_DIR)) {
    if (referenced.has(name)) continue;
    try {
      unlinkSync(join(IMAGES_DIR, name));
      removed++;
    } catch (err) {
      console.error(`[images] failed to sweep ${name}:`, err);
    }
  }
  if (removed > 0) console.log(`[images] swept ${removed} orphaned image file(s)`);
}
