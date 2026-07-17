# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

MiniTavern: self-hosted chat frontend for OpenAI-compatible LLM APIs with tree-structured conversation history (branch on edit, swipe AI replies as siblings). Everything runs in Docker — no node process is expected to run on the host, so run commands through `docker compose`.

## Live environments — do not disturb

The user keeps stacks running while working. Treat them as someone else's live session:

- **Dev stack** (`docker-compose.dev.yml`: `server`, `client`, host port 5488/5173, state in `./data-dev`) is the user's live hot-reload environment. Never `up`, `stop`, `restart`, or attach `--profile mock` to it. Code edits hot-reload on their own — no restart is ever needed.
- **Prod stack** (`docker-compose.yml`: container `minitavern`, host port **5487**, state in `./data`) may also be running. Never touch it or its data.
- Never run tests or ad-hoc scripts against either live server — the e2e suite mutates global settings, creates endpoints/conversations, and would repoint the active endpoint at the mock mid-session.
- One-off throwaway containers are always safe: `docker compose -f docker-compose.dev.yml run --rm --no-deps server <cmd>` (used for typecheck/format below). It does not start or affect stack services.

## Commands

```sh
# First time / after dependency changes
docker compose -f docker-compose.dev.yml run --rm --no-deps server npm install

# Typecheck (tsc --noEmit for server + client; there is no lint step)
docker compose -f docker-compose.dev.yml run --rm --no-deps server npm run check

# Format (Prettier, enforced repo-wide)
docker compose -f docker-compose.dev.yml run --rm --no-deps server npm run format

# E2E tests (the only test suite) — run fully ISOLATED, never against the live stacks:
# separate compose project, server+mock inside one throwaway container,
# container-local DATA_DIR, non-default ports.
docker compose -p minitavern-e2e -f docker-compose.dev.yml run --rm --no-deps \
  -e DATA_DIR=/tmp/e2e-data -e E2E_BASE=http://127.0.0.1:15487 -e E2E_MOCK=http://127.0.0.1:19800/v1 \
  server sh -c 'PORT=15487 node server/src/index.ts >/tmp/server.log 2>&1 & \
    PORT=19800 node scripts/mock-openai.ts >/tmp/mock.log 2>&1 & \
    sleep 2; node scripts/e2e.ts; ec=$?; tail -5 /tmp/server.log; exit $ec'
# Afterwards: docker network rm minitavern-e2e_default
```

There is no server build step: Node 26 runs the TypeScript sources directly (`node server/src/index.ts`). Only the client is bundled (Vite), and only for production.

## Architecture

npm workspaces: `shared/` (types only), `server/` (dependency-light Node: `node:sqlite`, `ws`, hand-rolled router), `client/` (SolidJS + Vite).

**`shared/src/index.ts` is the contract.** All entity types (`Message`, `Conversation`, `Character`, `Endpoint`, …), the WebSocket protocol (`ServerEvent` / `ClientCommand`), and default settings live here and are imported by both sides. Protocol changes start in this file.

**Server-authoritative state, clients are pure viewers.** All state lives in SQLite (`server/src/db.ts`, schema migrations via `PRAGMA user_version`, WAL mode). All SQL goes through `stmt()` from db.ts — a memoized prepared-statement cache; never call `db.prepare` directly. Clients never mutate locally; they call REST endpoints under `/api/` and receive updates over the `/ws` WebSocket:

- `tree` — full snapshot of a conversation's message tree (sent on subscribe and after any structural change; `broadcastTree` coalesces per microtask, so several mutations in one request emit one frame)
- `delta` — streaming token append (`d` = content, `r` = reasoning) for one message id
- `final` — a message finished streaming
- `invalidate` — an entity list (characters, endpoints, settings, …) changed; client refetches via `client/src/state/api.ts`

Each WebSocket client subscribes to at most one conversation (`events.ts`). The client keeps one global Solid store (`client/src/state/store.ts`); `ws.ts` reconnects with backoff and resubscribes/resyncs on reopen.

**Route registration is by side effect.** `server/src/router.ts` is a tiny regex router; each file in `server/src/routes/` registers its routes at import time, and `server/src/index.ts` imports them for their side effects. A new route file does nothing until added to that import list. Entity CRUD (presets, templates, personas, characters, endpoints) is table-driven: `defineEntityRoutes` in `server/src/routes/entityRoutes.ts` generates list/create/patch/delete from a field spec (column, validator, current-value merge); only bespoke routes (avatars, card import/export, model fetching) live in the per-entity files. Adding a column to an entity means: schema migration, shared type, `toX` mapper, one field-spec line.

**The message tree** (`server/src/tree.ts`): messages form a tree via `parentId`; each node stores `activeChildId` and the conversation stores `activeLeafId`. `setActiveLeaf` repoints `active_child_id` along the entire new path — this invariant is what lets switching back to a branch restore the deep chain that was previously active beneath it.

**Optimistic concurrency** (`server/src/concurrency.ts`): mutating conversation endpoints require `expectedActiveLeafId`; a mismatch returns 409 and rebroadcasts the tree so the stale client resyncs. Settings writes are similarly guarded by a monotonic `revision`.

**Generation** (`server/src/generation.ts`): in-flight streams are kept in an in-memory `active` map keyed by message id, with a flush timer batching deltas to subscribers. `mergeLiveBuffers` overlays in-flight content onto tree snapshots so a client subscribing mid-stream sees partial text. Prompt assembly is in `prompt.ts` (template rendering with `{{#if}}` blocks, `{{char}}`/`{{user}}` macros, optional name prefixing + assistant prefill whose mechanism depends on the endpoint's `prefillMode`).

**Speculative swipes** (`server/src/speculation.ts`): when `backgroundSwipeGeneration` is on, the server keeps one unread assistant sibling generating ahead of the active reply (`generationKind: 'speculative'`). It is promoted to a normal foreground generation when the user swipes to it, discarded on branch/context changes, and refilled lazily for subscribed conversations with backoff retries (capped at 8 attempts; explicit user actions reset the budget).

**IP allowlist**: every HTTP request and WebSocket upgrade is gated by source IP (`server/src/ipAccess.ts`; the Vite dev server has an equivalent plugin in `client/vite.config.ts`). Configured via `MINITAVERN_IP_ALLOWLIST` in a gitignored `.env`; defaults allow loopback + private ranges. Docker-internal traffic (e.g. the mock, e2e runs) needs `172.16.0.0/12`.

**Mock LLM** (`scripts/mock-openai.ts`): OpenAI-compatible streaming endpoint at `http://mock:9800/v1` (from inside the compose network) with `/control/*` endpoints to inject failures; the e2e suite drives it.
