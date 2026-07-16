import { deflateSync, inflateSync } from 'node:zlib';

export interface ParsedCard {
  name: string;
  personality: string;
  scenario: string;
  firstMessage: string;
  systemPrompt: string | null;
  raw: unknown;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function extractTextChunks(png: Buffer): Map<string, string> {
  if (png.length < 8 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Not a PNG file');
  }
  const chunks = new Map<string, string>();
  let off = 8;
  while (off + 12 <= png.length) {
    const length = png.readUInt32BE(off);
    const type = png.toString('latin1', off + 4, off + 8);
    const data = png.subarray(off + 8, off + 8 + length);
    if (type === 'tEXt') {
      const nul = data.indexOf(0);
      if (nul > 0) chunks.set(data.toString('latin1', 0, nul), data.toString('latin1', nul + 1));
    } else if (type === 'iTXt') {
      const nul = data.indexOf(0);
      if (nul > 0) {
        const keyword = data.toString('latin1', 0, nul);
        const compressed = data[nul + 1] === 1;
        // Skip compression flag+method, then language tag and translated keyword (both NUL-terminated).
        let p = nul + 3;
        p = data.indexOf(0, p) + 1;
        p = data.indexOf(0, p) + 1;
        if (p > 0 && p <= data.length) {
          const payload = data.subarray(p);
          chunks.set(
            keyword,
            compressed ? inflateSync(payload).toString('utf8') : payload.toString('utf8'),
          );
        }
      }
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + length;
  }
  return chunks;
}

interface CardData {
  name?: string;
  description?: string;
  personality?: string;
  scenario?: string;
  first_mes?: string;
  system_prompt?: string;
}

/** Parses a SillyTavern character card PNG (V1 flat, V2 'chara', or V3 'ccv3'). */
export function parseCharacterCard(png: Buffer): ParsedCard {
  const chunks = extractTextChunks(png);
  const encoded = chunks.get('ccv3') ?? chunks.get('chara');
  if (!encoded) throw new Error('No character card data found in PNG (missing chara/ccv3 chunk)');
  let json: { spec?: string; data?: CardData } & CardData;
  try {
    json = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  } catch {
    throw new Error('Character card data is not valid base64 JSON');
  }
  const data: CardData = json.data ?? json;
  if (!data.name) throw new Error('Character card has no name');
  const personality = [data.description?.trim(), data.personality?.trim()]
    .filter(Boolean)
    .join('\n\n');
  return {
    name: data.name,
    personality,
    scenario: data.scenario?.trim() ?? '',
    firstMessage: data.first_mes?.trim() ?? '',
    systemPrompt: data.system_prompt?.trim() || null,
    raw: json,
  };
}

// ---- Card export ----

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function buildChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const out = Buffer.alloc(head.length + 8);
  out.writeUInt32BE(data.length, 0);
  head.copy(out, 4);
  out.writeUInt32BE(crc32(head), head.length + 4);
  return out;
}

/** Minimal fallback portrait for characters without a PNG avatar. */
export function makePlaceholderPng(): Buffer {
  const size = 256;
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 3 + 1);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      raw[rowStart + 1 + x * 3] = 0x17;
      raw[rowStart + 2 + x * 3] = 0x17;
      raw[rowStart + 3 + x * 3] = 0x17;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    PNG_SIGNATURE,
    buildChunk('IHDR', ihdr),
    buildChunk('IDAT', deflateSync(raw, { level: 9 })),
    buildChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Embeds a V2 character card into a PNG: strips any existing chara/ccv3
 * chunks and inserts a fresh tEXt 'chara' chunk before IEND.
 */
export function buildCharacterCard(png: Buffer, card: unknown): Buffer {
  if (png.length < 8 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('avatar is not a PNG');
  }
  const parts: Buffer[] = [png.subarray(0, 8)];
  let off = 8;
  while (off + 12 <= png.length) {
    const length = png.readUInt32BE(off);
    const type = png.toString('latin1', off + 4, off + 8);
    const chunk = png.subarray(off, off + 12 + length);
    off += 12 + length;
    if (type === 'tEXt' || type === 'iTXt') {
      const data = chunk.subarray(8, 8 + length);
      const nul = data.indexOf(0);
      const keyword = nul > 0 ? data.toString('latin1', 0, nul) : '';
      if (keyword === 'chara' || keyword === 'ccv3') continue; // strip old card
    }
    if (type === 'IEND') break;
    parts.push(chunk);
  }
  const payload = Buffer.concat([
    Buffer.from('chara', 'latin1'),
    Buffer.from([0]),
    Buffer.from(Buffer.from(JSON.stringify(card), 'utf8').toString('base64'), 'latin1'),
  ]);
  parts.push(buildChunk('tEXt', payload));
  parts.push(buildChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}
