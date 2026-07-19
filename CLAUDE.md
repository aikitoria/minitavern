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

## Screenshots

When the user references a screenshot by bare filename (e.g. `chrome_o4vT3bpfcy.png`), the file is in `/raid/share/` — Read it from there before responding.

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

- `tree` — full snapshot of a conversation's message tree (sent on subscribe; also the client's resync fallback)
- `treePatch` — incremental structural update after mutations (`broadcastTree` coalesces per microtask): `nodes` lists every message's structure (absent ids were deleted), `messages` carries full bodies only for messages created/edited since the last frame (tracked via `markMessageDirty` in tree.ts). Structural updates include `parentId` — splice deletions and block moves reparent messages without resending bodies, and the client must apply it.
- `delta` — streaming token append (`d` = content, `r` = reasoning) for one message id
- `final` — a message finished streaming
- `imageProgress` — image render progress (e.g. sampler steps) for a message with `imagePending`
- `invalidate` — an entity list (characters, endpoints, settings, …) changed; client refetches via `client/src/state/api.ts`

Each WebSocket client subscribes to at most one conversation (`events.ts`). The client keeps one global Solid store (`client/src/state/store.ts`); `ws.ts` reconnects with backoff and resubscribes/resyncs on reopen.

**Client conventions**: the settings editors are imperative — they load/save via `.value` on refs (`createEntityEditor` in util.ts). Two custom components honor that contract: `MacroTextarea` (macro-highlight overlay; intercepts the element's `value` property so programmatic loads re-render, and mirrors scrollbar width/scroll position onto the overlay) and `Select` (scroll-proof dropdown replacing native `<select>`, which closes on any wheel tick; exposes a `SelectHandle` with a `value` accessor). Sibling swipe animations run off the `pendingSwipe` signal in store.ts: the outgoing side slides fully out and holds until the replacing `treePatch` unmounts it, the incoming sibling/descendants consume the signal at mount time to slide in.

**Route registration is by side effect.** `server/src/router.ts` is a tiny regex router; each file in `server/src/routes/` registers its routes at import time, and `server/src/index.ts` imports them for their side effects. A new route file does nothing until added to that import list. Entity CRUD (presets, templates, personas, characters, endpoints) is table-driven: `defineEntityRoutes` in `server/src/routes/entityRoutes.ts` generates list/create/patch/delete from a field spec (column, validator, current-value merge); only bespoke routes (avatars, card import/export, model fetching) live in the per-entity files. Adding a column to an entity means: schema migration, shared type, `toX` mapper, one field-spec line.

**The message tree** (`server/src/tree.ts`): messages form a tree via `parentId`; each node stores `activeChildId` and the conversation stores `activeLeafId`. `setActiveLeaf` repoints `active_child_id` along the entire new path — this invariant is what lets switching back to a branch restore the deep chain that was previously active beneath it.

**Tree operations**: the delete button means "remove this block from the screen" (`spliceMessage`): the message AND its sibling swipes are deleted (a swipe's subtree dies with it) while the message's own children reattach to its parent — whole-tail removal is `/del` (delete-tail). `rotateDown` implements the ⋯ menu's move up/down as a block rotation: the moved message's sibling group reattaches under its active child, whose group rises to the parent, and its former children reattach under the moved message. Duplicate creates an activated sibling copy (content/name/reasoning/render-config; image files are never shared between messages). Subtree deletion (`deleteMessage`) survives only for internal speculative cleanup.

**Optimistic concurrency** (`server/src/concurrency.ts`): mutating conversation endpoints require `expectedActiveLeafId`; a mismatch returns 409 and rebroadcasts the tree so the stale client resyncs. Settings writes are similarly guarded by a monotonic `revision`.

**Synchronous route handlers are the concurrency model.** Route handlers in `server/src/routes/` are race-free only because they run fully synchronously between check and act — Node's single thread serializes them against each other and against generation/streaming callbacks, so guard-then-act sequences like `hasActiveGeneration` → `startGeneration` are atomic. Introducing a single `await` mid-handler reopens double-generation and active-leaf races; if a handler ever needs to await, every checked precondition must be re-validated after it.

**Generation** (`server/src/generation.ts`): in-flight streams are kept in an in-memory `active` map keyed by message id, with a dirty-flagged flush timer persisting to the DB. `mergeLiveBuffers` overlays in-flight content onto tree snapshots so a client subscribing mid-stream sees partial text. The endpoint resolves per generation: conversation `endpointId` override → global `activeEndpointId`. Transient upstream failures (5xx/429, network errors, idle timeout) retry up to 2× on foreground generations, resuming from the partial content prefill-style; 4xx fails immediately and the client toasts `genMeta.error` (background swipes rely on speculation.ts's own retry instead). The `active` map uses identity checks (`active.get(mid) === gen`) because `continue` reuses message ids.

**Prompt assembly** (`server/src/prompt.ts`): the system prompt resolves character `customPrompt` → character preset → global default preset. The template resolves character inline `customTemplate` (a JSON `CustomTemplate` with the same settings as a template entity) → character `templateId` → global default template → built-in `DEFAULT_PROMPT_TEMPLATE`. A template carries: content (rendered with `{{#if}}` blocks and macro slots), an optional fake first user message, speaker-name prefixing (which also drives assistant prefill via the endpoint's `prefillMode`), and `usesPersonas` — when false the persona is ignored entirely (`{{user}}` = "User"; the client mirrors this via the `personasEnabled` memo).

**Plugins** (`client/src/plugins/`): a client-side plugin (contract in `api.ts`, registry in `index.ts`) contributes composer tools-menu buttons, slash commands, a page in Settings → Tools (`ToolsTab` renders any plugin with a `settingsPage`), and a `messageView` — it claims tool messages by their data and `create()` returns `Header`/`Body` render functions sharing per-message state via closures (MessageNode delegates to them). Plugin CSS lives in a plugin-owned stylesheet imported by the plugin module. Plugin settings persist in `Settings.pluginSettings[pluginId]` (arbitrary JSON blob, revision-guarded like all settings, synced via the settings invalidate; `pluginSettings()`/`savePluginSettings()` helpers). The Image Generation plugin is the reference: `/image [instruction]` expands `{{instruction}}` client-side, then runs a **tool generation**.

**Tool generations** (`POST /api/conversations/:id/tool`): a plugin prompt runs as a normal foreground generation streaming into a `role: 'tool'` message appended at the active leaf — so all concurrency/streaming/retry machinery applies unchanged. The prompt gets the full chat context plus the macro-expanded prompt as a trailing user turn (`buildToolPrompt`; `{{char}}`/`{{user}}` expand server-side, no name prefill), snapshotted at route time via the generation's `promptOverride` so retries stay consistent. Tool messages are chat-visible but skipped by `buildChatMessages`, so they never enter later prompt history; they can't be swiped/advanced/resumed (assistant-role guards on both sides). Starting one discards an in-flight speculative swipe without refilling (a branch switch restarts speculation anyway).

**Image rendering** (`server/src/comfy.ts`): a tool request may carry `image: { workflow, comfyUrl }` (ComfyUI API-format JSON with `{{prompt}}`/`{{seed}}` slots, validated at route time, persisted on the message as `image_render_json`). When the text generation completes, the server expands `{{prompt}}` (JSON-string-escaped message content) and `{{seed}}` (fresh random int per render), submits to ComfyUI, relays per-step progress from its WebSocket as `imageProgress` events (polling `/history` drives completion, so the socket is optional), downloads the output and appends it to the message's `images[]` (served immutable under `/images/`, stored in `DATA_DIR/images`). `imagePending` flags an in-flight render (cleared by finalize on non-done text generations, by the failure path with `genMeta.imageError`, and at boot). `POST /api/messages/:id/render-image` re-renders with a fresh seed (image swipes; accepts a fallback config for pre-config messages and stores it); `/:id/active-image` persists the selected alternative. **Image files are hard-deleted with their rows**: every deletion path collects doomed paths before the SQL and unlinks after commit (`server/src/images.ts`), with a startup sweep of unreferenced files as the crash-window backstop. The compose files join the external `my-bridge-network` so the server reaches ComfyUI at `http://comfy:8588`; the mock implements the ComfyUI surface (`/prompt`, `/history`, `/view` with strict file params, ws progress) for e2e, including failure injection via `/control/comfy-fail-next?stage=prompt|render&count=N`.

**Assistant is a seeded character** (migration 11), not a special case: `characterId: null` remains a legacy/fallback path. Conversations created with a greeting-less character start titled "New chat" and auto-title from the first message; greeting characters are titled with their name. Once the FIRST assistant reply in a "New chat" conversation completes, a silent one-shot (non-streaming) completion through the resolved endpoint generates a short LLM title (`maybeAutoTitle` in conversations.ts): it only fires while the title is still the placeholder/fallback (a user rename wins), never bumps `updated_at`, and keeps the old title on failure.

**Steered regeneration** (`POST /api/messages/:id/regenerate`): like advancing past the last sibling, but the prompt is snapshotted at route time via `promptOverride` (`buildSteeredPrompt`) with the instruction rendered into `settings.steerTemplate` (`{{instruction}}` slot) as a trailing system message — it steers that one generation only and never enters message history.

**`updated_at` means "last new content"**: content-creating routes (send, spawn, resume, edits, deletes) call `touchConversation`; `setActiveLeaf` deliberately does NOT bump it, so branch switching and swiping between already-seen siblings never reorder the sidebar. Swiping onto a not-yet-seen speculative sibling does bump — revealing it is the moment that content "arrives", same as a foreground regeneration.

**Search**: message contents are indexed in an external-content FTS5 table (`messages_fts`, kept in sync by insert/update/delete triggers on `messages` — any SQL write path is covered automatically). The search route quotes user tokens as FTS phrases (last token prefix-matched) and generates snippets; note `snippet()` refuses aggregate contexts and SQLite flattens subqueries, so best-per-conversation dedupe happens in JS. Titles use escaped-LIKE substring search. Entity list endpoints sort by name (`COLLATE NOCASE`).

**Speculative swipes** (`server/src/speculation.ts`): when `backgroundSwipeGeneration` is on, the server keeps one unread assistant sibling generating ahead of the active reply (`generationKind: 'speculative'`). It is promoted to a normal foreground generation when the user swipes to it, discarded on branch/context changes, and refilled lazily for subscribed conversations with backoff retries (capped at 8 attempts; explicit user actions reset the budget).

**IP allowlist**: every HTTP request and WebSocket upgrade is gated by source IP (`server/src/ipAccess.ts`; the Vite dev server has an equivalent plugin in `client/vite.config.ts`). Configured via `MINITAVERN_IP_ALLOWLIST` in a gitignored `.env`; defaults allow loopback + private ranges. Docker-internal traffic (e.g. the mock, e2e runs) needs `172.16.0.0/12`.

**Mock LLM** (`scripts/mock-openai.ts`): OpenAI-compatible streaming endpoint at `http://mock:9800/v1` (from inside the compose network) with `/control/*` endpoints to inject failures; the e2e suite drives it.
