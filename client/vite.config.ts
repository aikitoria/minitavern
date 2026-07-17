import { existsSync, readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import solid from 'vite-plugin-solid';
// The vite config runs under Node (outside the client tsconfig), so it can
// share the server's allowlist parser instead of duplicating it.
import { createIpAllowlist } from '../server/src/ipAccess.ts';

const target = process.env.VITE_PROXY_TARGET ?? 'http://localhost:5487';
const allowlist = createIpAllowlist(process.env.MINITAVERN_IP_ALLOWLIST);
const ipAllowed = (address?: string) => allowlist.isAllowed(address);

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
