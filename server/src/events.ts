import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import type { ClientCommand, InvalidateEntity, ServerEvent } from '@minitavern/shared';

const clients = new Map<WebSocket, { sub: number | null }>();
let onSubscribe: ((ws: WebSocket, conversationId: number) => void) | null = null;

/** Called whenever a client subscribes to a conversation (used to push the initial tree). */
export function setSubscribeHandler(fn: (ws: WebSocket, conversationId: number) => void): void {
  onSubscribe = fn;
}

export function initWebSocket(server: Server): void {
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    clients.set(ws, { sub: null });
    ws.send(JSON.stringify({ t: 'hello' } satisfies ServerEvent));
    ws.on('message', (data) => {
      let cmd: ClientCommand;
      try {
        cmd = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (typeof cmd.sub === 'number' || cmd.sub === null) {
        clients.get(ws)!.sub = cmd.sub;
        if (cmd.sub != null) onSubscribe?.(ws, cmd.sub);
      }
    });
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });
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

export function invalidate(entity: InvalidateEntity): void {
  broadcast({ t: 'invalidate', entity });
}
