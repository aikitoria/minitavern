import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AVATAR_DIR } from '../db.ts';
import { HttpError } from '../router.ts';

const IMAGE_EXTS = ['png', 'jpg', 'webp'];

/** File type from magic bytes — content-type headers lie (a renamed JPEG
 * stored as character-N.png would later break PNG card export). */
function sniffImageExt(data: Buffer): string | null {
  if (
    data.length >= 8 &&
    data.readUInt32BE(0) === 0x89504e47 &&
    data.readUInt32BE(4) === 0x0d0a1a0a
  )
    return 'png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpg';
  if (
    data.length >= 12 &&
    data.toString('latin1', 0, 4) === 'RIFF' &&
    data.toString('latin1', 8, 12) === 'WEBP'
  )
    return 'webp';
  return null;
}

export type AvatarKind = 'character' | 'persona';

export function deleteAvatarFiles(kind: AvatarKind, id: number): void {
  for (const ext of IMAGE_EXTS) {
    try {
      unlinkSync(join(AVATAR_DIR, `${kind}-${id}.${ext}`));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}

/** Reads the stored avatar file regardless of extension (legacy avatars may
 * be jpg/webp from before uploads were restricted to PNG). */
export function readAvatarFile(kind: AvatarKind, id: number): Buffer | null {
  for (const ext of IMAGE_EXTS) {
    try {
      return readFileSync(join(AVATAR_DIR, `${kind}-${id}.${ext}`));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return null;
}

export function saveAvatar(kind: AvatarKind, id: number, data: Buffer): string {
  const ext = sniffImageExt(data);
  // PNG only: character card export embeds the card JSON into the avatar PNG,
  // and dependency-free transcoding isn't available — accept nothing else.
  if (ext !== 'png') throw new HttpError(415, 'avatar must be a PNG image');
  deleteAvatarFiles(kind, id);
  const filename = `${kind}-${id}.${ext}`;
  writeFileSync(join(AVATAR_DIR, filename), data);
  return `/avatars/${filename}?v=${Date.now()}`;
}
