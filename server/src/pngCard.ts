import { inflateSync } from 'node:zlib';

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
