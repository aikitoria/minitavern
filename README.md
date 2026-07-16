# MiniTavern

Small but mighty self-hosted chat frontend for OpenAI-compatible LLM APIs.

- Tree-structured conversation history: edit any user message to branch, regenerate AI replies as siblings, switch branches with `‹ n/m ›` — the previously active chain under each branch is restored when you switch back.
- Server-authoritative state in SQLite; clients are pure viewers synced live over WebSocket. Open the same chat on desktop and phone and watch streams arrive on both.
- Characters (with SillyTavern PNG card import), system prompt presets, user personas with `{{char}}`/`{{user}}` macros, multiple named API endpoints.
- Responsive: desktop two-pane layout, mobile PWA with bottom composer.

Everything runs in Docker — no node process ever touches the host.

## Production

```sh
mkdir -p data
docker compose up --build -d
```

Open `http://<host>:5487`. State lives in `./data`.

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

## Development

```sh
mkdir -p data
docker compose -f docker-compose.dev.yml run --rm server npm install
docker compose -f docker-compose.dev.yml up            # add --profile mock for a fake LLM API
```

- Client (Vite, HMR): `http://localhost:5173`
- Server API: `http://localhost:5487`
- Mock OpenAI API endpoint (with `--profile mock`): base URL `http://mock:9800/v1`, any API key.

Typecheck:

```sh
docker compose -f docker-compose.dev.yml run --rm server npm run check
```

## First-run setup

1. Open Settings (⚙) → **Endpoints**, add your OpenAI-compatible API (base URL up to `/v1`), create it, "Fetch models", pick the model and sampling settings, save.
2. In **General**, pick the active endpoint.
3. Optionally define **Prompts** (system prompt presets), **Templates**, **Characters** (or import PNG cards) and **Personas**.
