import { unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AVATAR_DIR } from '../db.ts';
import { HttpError } from '../router.ts';

const IMAGE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

export type AvatarKind = 'character' | 'persona';

export function deleteAvatarFiles(kind: AvatarKind, id: number): void {
  for (const ext of Object.values(IMAGE_EXT)) {
    try {
      unlinkSync(join(AVATAR_DIR, `${kind}-${id}.${ext}`));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}

export function saveAvatar(
  kind: AvatarKind,
  id: number,
  data: Buffer,
  contentType: string,
): string {
  const ext = IMAGE_EXT[contentType.split(';', 1)[0]!.trim().toLowerCase()];
  if (!ext) throw new HttpError(415, 'avatar must be image/png, image/jpeg or image/webp');
  deleteAvatarFiles(kind, id);
  const filename = `${kind}-${id}.${ext}`;
  writeFileSync(join(AVATAR_DIR, filename), data);
  return `/avatars/${filename}?v=${Date.now()}`;
}
