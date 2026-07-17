import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import type { ClientCommand, InvalidateEntity, ServerEvent } from '@minitavern/shared';
import { isRequestIpAllowed } from './ipAccess.ts';

const clients = new Map<WebSocket, { sub: number | null; alive: boolean }>();
let onSubscribe: ((ws: WebSocket, conversationId: number) => void) | null = null;

/** Called whenever a client subscribes to a conversation (used to push the initial tree). */
export function setSubscribeHandler(fn: (ws: WebSocket, conversationId: number) => void): void {
  onSubscribe = fn;
}

export function initWebSocket(server: Server): void {
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    verifyClient: ({ req }, done) => {
      if (isRequestIpAllowed(req)) done(true);
      else done(false, 403, 'IP address is not allowed');
    },
  });
  wss.on('connection', (ws) => {
    clients.set(ws, { sub: null, alive: true });
    ws.send(JSON.stringify({ t: 'hello' } satisfies ServerEvent));
    ws.on('message', (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (parsed == null || typeof parsed !== 'object' || !('sub' in parsed)) return;
      const cmd = parsed as ClientCommand;
      if (cmd.sub === null || (Number.isSafeInteger(cmd.sub) && cmd.sub > 0)) {
        clients.get(ws)!.sub = cmd.sub;
        if (cmd.sub != null) onSubscribe?.(ws, cmd.sub);
      }
    });
    ws.on('pong', () => {
      const state = clients.get(ws);
      if (state) state.alive = true;
    });
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });
  const heartbeat = setInterval(() => {
    for (const [ws, state] of clients) {
      if (!state.alive) {
        ws.terminate();
        clients.delete(ws);
        continue;
      }
      state.alive = false;
      ws.ping();
    }
  }, 30_000);
  heartbeat.unref();
  wss.on('close', () => clearInterval(heartbeat));
}

export function sendTo(ws: WebSocket, ev: ServerEvent): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(ev));
}

/** Broadcast to every connected client. */
export function broadcast(ev: ServerEvent): void {
  const payload = JSON.stringify(ev);
  for (const ws of clients.keys()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

/** Broadcast to clients subscribed to a specific conversation. */
export function broadcastConv(conversationId: number, ev: ServerEvent): void {
  const payload = JSON.stringify(ev);
  for (const [ws, state] of clients) {
    if (state.sub === conversationId && ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

/** Conversations currently visible in at least one connected client. */
export function subscribedConversationIds(): number[] {
  return [
    ...new Set([...clients.values()].flatMap((state) => (state.sub == null ? [] : [state.sub]))),
  ];
}

export function invalidate(entity: InvalidateEntity): void {
  broadcast({ t: 'invalidate', entity });
}
