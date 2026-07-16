import { existsSync, readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

const target = process.env.VITE_PROXY_TARGET ?? 'http://localhost:5487';

// Serve the dev client over HTTPS with the same cert as prod when available.
const certPath = process.env.TLS_CERT_PATH;
const keyPath = process.env.TLS_KEY_PATH;
const https =
  certPath && keyPath && existsSync(certPath) && existsSync(keyPath)
    ? { cert: readFileSync(certPath), key: readFileSync(keyPath) }
    : undefined;

export default defineConfig({
  plugins: [solid()],
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
