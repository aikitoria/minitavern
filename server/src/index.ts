import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { existsSync, readFileSync, watch } from 'node:fs';
import { stat, readFile } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AVATAR_DIR, IMAGES_DIR } from './db.ts';
import { dispatch } from './router.ts';
import { initWebSocket, setSubscribeHandler, subscribedConversationIds } from './events.ts';
import { sendTreeTo } from './sync.ts';
import { prepareActiveSwipe } from './routes/conversations.ts';
import { configuredIpAllowlist, isRequestIpAllowed, requestIp } from './ipAccess.ts';
import { setSpeculativeRefillHandler } from './speculation.ts';
import { sweepOrphanedImages } from './images.ts';
import './routes/messages.ts';
import './routes/presets.ts';
import './routes/templates.ts';
import './routes/personas.ts';
import './routes/characters.ts';
import './routes/avatarGenerate.ts';
import './routes/endpoints.ts';
import './routes/settings.ts';

const PORT = Number(process.env.PORT ?? 5487);
const CLIENT_DIST = process.env.CLIENT_DIST ?? '';

// Backstop for image-file deletion guarantees (crash windows, late renders).
sweepOrphanedImages();

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

async function serveFile(res: ServerResponse, path: string, immutable: boolean): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    const data = await readFile(path);
    res.writeHead(200, {
      'content-type': MIME[extname(path)] ?? 'application/octet-stream',
      'content-length': data.length,
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

function safeJoin(root: string, urlPath: string): string | null {
  const base = resolve(root);
  const path = resolve(base, urlPath.replace(/^\/+/, ''));
  const rel = relative(base, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? path : null;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isRequestIpAllowed(req)) {
    res
      .writeHead(403, { 'content-type': 'application/json' })
      .end(JSON.stringify({ error: 'IP address is not allowed' }));
    console.warn(`[access] rejected ${requestIp(req) ?? 'unknown address'}`);
    return;
  }
  const url = new URL(req.url ?? '/', 'http://x');
  const pathname = url.pathname;

  if (pathname.startsWith('/api/')) {
    if (await dispatch(req, res, pathname)) return;
    res
      .writeHead(404, { 'content-type': 'application/json' })
      .end(JSON.stringify({ error: 'not found' }));
    return;
  }

  if (pathname.startsWith('/avatars/')) {
    const path = safeJoin(AVATAR_DIR, pathname.slice('/avatars/'.length));
    if (path && (await serveFile(res, path, false))) return;
    res.writeHead(404).end();
    return;
  }

  if (pathname.startsWith('/images/')) {
    // Generated images never change once written — serve immutable.
    const path = safeJoin(IMAGES_DIR, pathname.slice('/images/'.length));
    if (path && (await serveFile(res, path, true))) return;
    res.writeHead(404).end();
    return;
  }

  if (CLIENT_DIST) {
    const path = safeJoin(CLIENT_DIST, pathname === '/' ? '/index.html' : pathname);
    const immutable = pathname.startsWith('/assets/');
    if (path && (await serveFile(res, path, immutable))) return;
    // SPA fallback for client-side routes.
    if (req.method === 'GET' && !extname(pathname)) {
      if (await serveFile(res, join(CLIENT_DIST, 'index.html'), false)) return;
    }
  }
  res.writeHead(404).end('not found');
}

function onRequest(req: IncomingMessage, res: ServerResponse): void {
  handleRequest(req, res).catch((err) => {
    console.error('[http] unhandled error:', err);
    if (!res.writableEnded) res.writeHead(500).end();
  });
}

const certPath = process.env.TLS_CERT_PATH;
const keyPath = process.env.TLS_KEY_PATH;
let server: http.Server | https.Server;
let listener: net.Server;

if (certPath && keyPath) {
  if (!existsSync(certPath) || !existsSync(keyPath)) {
    console.error(`TLS cert or key not found (${certPath}, ${keyPath})`);
    process.exit(1);
  }
  const readContext = () => ({ cert: readFileSync(certPath), key: readFileSync(keyPath) });
  const tlsServer = https.createServer(readContext(), onRequest);
  server = tlsServer;
  // Hot-reload the certificate on renewal without dropping the process.
  let reloadTimer: NodeJS.Timeout | null = null;
  const scheduleReload = () => {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      try {
        tlsServer.setSecureContext(readContext());
        console.log('[tls] certificate reloaded');
      } catch (err) {
        console.error('[tls] certificate reload failed:', err);
      }
    }, 1000);
  };
  for (const file of [certPath, keyPath]) {
    try {
      watch(file, scheduleReload);
    } catch (err) {
      console.error(`[tls] cannot watch ${file}:`, err);
    }
  }
  // Browsers default to plain http for bare IP:port URLs; sniff the first byte
  // (0x16 = TLS handshake) and redirect http requests to https on the same port.
  const redirect = http.createServer((req, res) => {
    res
      .writeHead(301, { location: `https://${req.headers.host ?? 'localhost'}${req.url ?? '/'}` })
      .end();
  });
  listener = net.createServer((socket) => {
    // A peer that connects but never sends a byte must not pin the socket
    // forever — destroy it if the first byte doesn't arrive in time.
    const sniffTimeout = setTimeout(() => socket.destroy(), 10_000);
    socket.once('readable', () => {
      clearTimeout(sniffTimeout);
      const first = socket.read(1) as Buffer | null;
      if (!first) {
        socket.destroy();
        return;
      }
      socket.unshift(first);
      (first[0] === 0x16 ? tlsServer : redirect).emit('connection', socket);
    });
    socket.once('close', () => clearTimeout(sniffTimeout));
    socket.on('error', () => socket.destroy());
  });
  console.log('[tls] HTTPS enabled (plain http redirects)');
} else {
  server = http.createServer(onRequest);
  listener = server;
}

setSubscribeHandler((ws, conversationId) => {
  // Runs inside the ws 'message' listener with no upstream containment (the
  // HTTP side has one in router.ts) — an escaping throw would crash the process.
  try {
    sendTreeTo(ws, conversationId);
    prepareActiveSwipe(conversationId);
  } catch (err) {
    console.error(`[ws] subscribe handler failed for conversation ${conversationId}:`, err);
  }
});
setSpeculativeRefillHandler((conversationId) => {
  const subscribed = subscribedConversationIds();
  const targets =
    conversationId == null
      ? subscribed
      : subscribed.includes(conversationId)
        ? [conversationId]
        : [];
  for (const id of targets) prepareActiveSwipe(id);
});
initWebSocket(server as http.Server);

listener.listen(PORT, () => {
  console.log(
    `minitavern server listening on ${certPath && keyPath ? 'https' : 'http'}://0.0.0.0:${PORT}`,
  );
  console.log(`IP allowlist: ${configuredIpAllowlist()}`);
});
