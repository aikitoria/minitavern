import type { ClientCommand, ServerEvent } from '@minitavern/shared';

let sock: WebSocket | null = null;
let currentSub: number | null = null;
let retryDelay = 500;
let started = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

// Set lazily to break the import cycle with store.ts.
let onEvent: ((ev: ServerEvent) => void) | null = null;
let onOpen: (() => void) | null = null;
let onStatus: ((connected: boolean) => void) | null = null;
let onUnauthorized: (() => void) | null = null;

export function configureWs(handlers: {
  onEvent: (ev: ServerEvent) => void;
  onOpen: () => void;
  onStatus: (connected: boolean) => void;
  onUnauthorized: () => void;
}): void {
  onEvent = handlers.onEvent;
  onOpen = handlers.onOpen;
  onStatus = handlers.onStatus;
  onUnauthorized = handlers.onUnauthorized;
}

function connect(): void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  sock = ws;
  ws.onopen = () => {
    retryDelay = 500;
    onStatus?.(true);
    // Resync: state may have changed while disconnected.
    onOpen?.();
    if (currentSub != null) send({ sub: currentSub });
  };
  ws.onmessage = (event) => {
    try {
      onEvent?.(JSON.parse(event.data as string) as ServerEvent);
    } catch (err) {
      console.error('[ws] bad event:', err);
    }
  };
  ws.onclose = (event) => {
    onStatus?.(false);
    sock = null;
    if (event.code === 4001) onUnauthorized?.();
    if (!started) return;
    reconnectTimer = setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 5000);
  };
  ws.onerror = () => ws.close();
}

export function startWs(): void {
  if (started) return;
  started = true;
  connect();
}

export function stopWs(): void {
  started = false;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  const current = sock;
  sock = null;
  current?.close();
  onStatus?.(false);
}

function send(cmd: ClientCommand): void {
  if (sock?.readyState === WebSocket.OPEN) sock.send(JSON.stringify(cmd));
}

export function subscribe(conversationId: number | null): void {
  currentSub = conversationId;
  send({ sub: conversationId });
}
