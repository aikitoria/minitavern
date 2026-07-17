import { BlockList, isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';

export const DEFAULT_IP_ALLOWLIST =
  '127.0.0.1/32,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,fc00::/7,fe80::/10';

/** Strips IPv6 zone ids ("fe80::1%eth0") and unwraps v4-mapped addresses. */
export function normalizeAddress(address: string): string {
  const zone = address.indexOf('%');
  const withoutZone = zone === -1 ? address : address.slice(0, zone);
  return withoutZone.toLowerCase().startsWith('::ffff:') ? withoutZone.slice(7) : withoutZone;
}

export interface IpAllowlist {
  /** The effective allowlist string (for logging). */
  configured: string;
  isAllowed(address: string | undefined): boolean;
}

/** Single source of truth for allowlist parsing — the Vite dev server imports this too. */
export function createIpAllowlist(env: string | undefined): IpAllowlist {
  const configured = env?.trim() || DEFAULT_IP_ALLOWLIST;
  const list = new BlockList();
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
    list.addSubnet(address, prefix, family === 4 ? 'ipv4' : 'ipv6');
  }
  return {
    configured,
    isAllowed(address) {
      const normalized = address ? normalizeAddress(address) : '';
      const family = isIP(normalized);
      return family !== 0 && list.check(normalized, family === 4 ? 'ipv4' : 'ipv6');
    },
  };
}

const allowlist = createIpAllowlist(process.env.MINITAVERN_IP_ALLOWLIST);

export function requestIp(req: IncomingMessage): string | null {
  const address = req.socket.remoteAddress;
  return address ? normalizeAddress(address) : null;
}

export function isRequestIpAllowed(req: IncomingMessage): boolean {
  return allowlist.isAllowed(req.socket.remoteAddress);
}

export function configuredIpAllowlist(): string {
  return allowlist.configured;
}
