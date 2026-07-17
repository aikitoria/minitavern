import { existsSync, readFileSync } from 'node:fs';
import { BlockList, isIP } from 'node:net';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import solid from 'vite-plugin-solid';

const target = process.env.VITE_PROXY_TARGET ?? 'http://localhost:5487';
const allowlistConfig =
  process.env.MINITAVERN_IP_ALLOWLIST ??
  '127.0.0.1/32,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,fc00::/7,fe80::/10';
const allowlist = new BlockList();

const normalizeAddress = (address: string) =>
  address.toLowerCase().startsWith('::ffff:') ? address.slice(7) : address;

for (const rawEntry of allowlistConfig.split(',')) {
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

const ipAllowed = (address?: string) => {
  const normalized = address ? normalizeAddress(address) : '';
  const family = isIP(normalized);
  return family !== 0 && allowlist.check(normalized, family === 4 ? 'ipv4' : 'ipv6');
};

const ipAllowlistPlugin: Plugin = {
  name: 'minitavern-ip-allowlist',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (ipAllowed(req.socket.remoteAddress)) next();
      else res.writeHead(403).end('IP address is not allowed');
    });
    server.httpServer?.prependListener('upgrade', (req, socket) => {
      if (ipAllowed(req.socket.remoteAddress)) return;
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    });
  },
};

// Serve the dev client over HTTPS with the same cert as prod when available.
const certPath = process.env.TLS_CERT_PATH;
const keyPath = process.env.TLS_KEY_PATH;
const https =
  certPath && keyPath && existsSync(certPath) && existsSync(keyPath)
    ? { cert: readFileSync(certPath), key: readFileSync(keyPath) }
    : undefined;

export default defineConfig({
  plugins: [ipAllowlistPlugin, solid()],
  build: { target: 'es2022' },
  server: {
    host: true,
    port: 5173,
    allowedHosts: true,
    https,
    proxy: {
      '/api': { target },
      '/avatars': { target },
      '/ws': { target, ws: true },
    },
  },
});
