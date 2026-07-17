# MiniTavern

Small but mighty self-hosted chat frontend for OpenAI-compatible LLM APIs.

- Tree-structured conversation history: edit any user message to branch, swipe AI replies as siblings, switch branches with `‹ n/m ›` — the previously active chain under each branch is restored when you switch back.
- Server-authoritative state in SQLite; clients are pure viewers synced live over WebSocket. Open the same chat on desktop and phone and watch streams arrive on both.
- Characters (with SillyTavern PNG card import/export), system prompt presets, prompt templates (fake first user message, speaker-name prefixing, per-template persona opt-out), user personas — all with live-highlighted `{{char}}`/`{{user}}`/`{{system}}`/`{{#if}}` macros. Characters can inline a custom prompt or a full custom template instead of referencing one.
- Multiple named API endpoints, each with its own model and sampling settings; conversations can override the global active endpoint. Transient upstream failures (5xx, network blips, stalls) retry automatically with the partial reply as prefill; real API errors (e.g. context length exceeded) surface as toasts.
- Optional background swipe generation: one unread reply alternative is always prepared ahead of the one you're reading.
- Plugin interface: plugins add buttons to the composer's tools menu, slash commands, and pages in Settings → Tools. Ships with an Image Generation plugin — `/image [instruction]` asks the model to describe the current scene as an image prompt (configurable prompts with an `{{instruction}}` macro), streamed into the chat as a distinct tool message that never enters later prompt history.
- Full-text message search (SQLite FTS5) with snippets, plus title search.
- Responsive: desktop two-pane layout, mobile PWA with bottom composer and swipe gestures.

Everything runs in Docker — no node process ever touches the host.

## Production

```sh
mkdir -p data
docker compose up --build -d
```

Open `http://<host>:5487`. State lives in `./data`.

### Network allowlist

HTTP and WebSocket access are restricted by source IP. Configure the addresses or CIDR ranges
allowed to use MiniTavern in the gitignored local `.env` file shared by both Compose stacks:

```sh
MINITAVERN_IP_ALLOWLIST=127.0.0.1/32,::1/128,192.168.1.20/32,192.168.1.0/24
```

When unset, loopback, RFC 1918 private networks, IPv6 unique-local addresses, and link-local
addresses are allowed. Keep `172.16.0.0/12` when using Docker-internal tools or the mock service.

### HTTPS

Put your certificate in `./certs` and uncomment the TLS lines in `docker-compose.yml`:

```yaml
volumes:
  - ./data:/data
  - ./certs:/certs:ro
environment:
  TLS_CERT_PATH: /certs/cert.pem
  TLS_KEY_PATH: /certs/key.pem
```

WebSockets automatically become `wss://`. Certificates are hot-reloaded on renewal.

## First-run setup

1. Open Settings (⚙) → **Endpoints**, add your OpenAI-compatible API (base URL up to `/v1`), create it, "Fetch models", pick the model and sampling settings, save.
2. In **General**, pick the active endpoint.
3. Start chatting with the built-in **Assistant** character — it's a regular character, so you can edit its system prompt/template in **Characters**, or clone the pattern into as many specialized assistants as you like. Optionally define **Prompts** (system prompt presets), **Templates**, more **Characters** (or import PNG cards) and **Personas**.

## Shortcuts and commands

- **Enter** sends, **Shift+Enter** inserts a newline (on touch layouts Enter is always a newline; use the send button).
- **↑** in an empty composer edits your last message in place; **Ctrl/Cmd+Enter** in any message editor submits as a new branch, **Escape** cancels.
- **←/→** swipe the last assistant reply between siblings (→ past the end regenerates); on touch, swipe the reply horizontally.
- `/char <name>` sets the assistant speaker name, `/del <n>` deletes the last n messages including their swipes and descendants, `/delchat` deletes the conversation.
- `/image [instruction]` generates an image description from the chat context (Image Generation plugin; prompts configurable in Settings → Tools).

## Development

```sh
mkdir -p data
docker compose -f docker-compose.dev.yml run --rm server npm install
docker compose -f docker-compose.dev.yml up            # add --profile mock for a fake LLM API
```

- Client (Vite, HMR): `http://localhost:5173`
- Server API: `http://localhost:5488`
- Mock OpenAI API endpoint (with `--profile mock`): base URL `http://mock:9800/v1`, any API key.

Typecheck:

```sh
docker compose -f docker-compose.dev.yml run --rm server npm run check
```

End-to-end tests run against a throwaway server+mock pair inside one container — they are
destructive and refuse to start without explicit targets, so never point them at a live instance:

```sh
docker compose -p minitavern-e2e -f docker-compose.dev.yml run --rm --no-deps \
  -e DATA_DIR=/tmp/e2e-data -e E2E_BASE=http://127.0.0.1:15487 -e E2E_MOCK=http://127.0.0.1:19800/v1 \
  server sh -c 'PORT=15487 node server/src/index.ts >/dev/null 2>&1 & \
    PORT=19800 node scripts/mock-openai.ts >/dev/null 2>&1 & \
    sleep 2; node scripts/e2e.ts'
docker network rm minitavern-e2e_default
```
