import { BlockList, isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';

export const DEFAULT_IP_ALLOWLIST =
  '127.0.0.1/32,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,fc00::/7,fe80::/10';

const configured = process.env.MINITAVERN_IP_ALLOWLIST?.trim() || DEFAULT_IP_ALLOWLIST;
const allowlist = new BlockList();

function normalizeAddress(address: string): string {
  const zone = address.indexOf('%');
  const withoutZone = zone === -1 ? address : address.slice(0, zone);
  return withoutZone.toLowerCase().startsWith('::ffff:') ? withoutZone.slice(7) : withoutZone;
}

for (const rawEntry of configured.split(',')) {
  const entry = rawEntry.trim();
  if (!entry) continue;
  const slash = entry.lastIndexOf('/');
  const address = normalizeAddress(slash === -1 ? entry : entry.slice(0, slash));
  const family = isIP(address);
  if (!family) throw new Error(`Invalid address in MINITAVERN_IP_ALLOWLIST: ${entry}`);
  const maxPrefix = family === 4 ? 32 : 128;
  const prefix = slash === -1 ? maxPrefix : Number(entry.slice(slash + 1));
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) {
    throw new Error(`Invalid prefix in MINITAVERN_IP_ALLOWLIST: ${entry}`);
  }
  allowlist.addSubnet(address, prefix, family === 4 ? 'ipv4' : 'ipv6');
}

export function requestIp(req: IncomingMessage): string | null {
  const address = req.socket.remoteAddress;
  return address ? normalizeAddress(address) : null;
}

export function isRequestIpAllowed(req: IncomingMessage): boolean {
  const address = requestIp(req);
  const family = address ? isIP(address) : 0;
  return family !== 0 && allowlist.check(address!, family === 4 ? 'ipv4' : 'ipv6');
}

export function configuredIpAllowlist(): string {
  return configured;
}
