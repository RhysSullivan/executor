# Executor v2 Plan

Reference implementations and inspiration for this plan:
 `../AnswerOverflow`
 `../quickhub`
 `../create-epoch-app`

## 1) Why v2 exists

Executor today is optimized for enterprise/team correctness (workspaces, org flows, cloud control), but has too much friction for per-user adoption.

v2 changes the default:

- **First-run must be local and immediate** (`npx executor <agent>` works fast).
- **No database dependency** in local-lite mode.
- **Cloud/self-host are upgrade targets**, not prerequisites.
- **One architecture for all modes** via adapters and shared contracts.

---

## 2) Product principles

1. **Local-first**
   - User gets value without login, org setup, or web onboarding.
2. **One mental model**
   - Same commands, same execution semantics across local and remote targets.
3. **Schema-first**
   - Effect Schema is the single source of truth for persisted/domain models.
4. **Execute-first tooling**
   - Top-level model tool surface is minimal; code execution is primary.
5. **Progressive complexity**
   - Advanced controls exist but are hidden until needed.
6. **Service-first Effect architecture**
   - Effectful orchestration is exposed as `Context.Tag` services + Layers; plain functions are for pure transforms.

---

## 3) Product modes and targets

### Modes

- **local-lite**: PM daemon + in-memory hot state + file persistence. No DB.
- **remote**: Convex-backed target (applies to both cloud and self-hosted).

### Key simplification

- `cloud` and `self-hosted` are not separate architecture branches.
- They are both **remote Convex targets**; only URL/auth/deployment ownership differs.

### Runtime targets (adapter-based)

- **`deno-subprocess`**: local sandbox runtime (current local secure target in v2).
- **`cloudflare-worker-loader`**: production cloud runtime target.
- **`node:vm`**: explicit unsafe/dev fallback only, not default.

---

## 4) Control + execution model

### Control role (conceptual)

Control includes source registry, policies, approvals/input workflow, identity/link state, and sync metadata.

- In local-lite: handled by `apps/pm`.
- In remote: handled by Convex + web stack.

### Execution role

Execution is provider-based: the runtime engine runs generated TypeScript, resolves `tools.*` calls, and routes invocation through source/tool providers (OpenAPI, MCP, GraphQL, in-memory, and future formats).

---

## 5) Monorepo shape (Executor-only)

```text
v2/
  apps/
    cli/
    pm/
    web/
    convex/

  packages/
    confect/            # imported from quickhub; Effect<->Convex schema bridge
    schema/             # canonical Effect schemas
    persistence-ports/
    persistence-local/
    persistence-convex/
    domain/
    approvals/
    source-manager/
    engine/
    mcp-gateway/
    oauth/
    secrets/
    sync/
    rpc/
    sdk/
    ai-sdk-adapter/
```

---

## 6) Dependency order (high-level)

```text
confect -> schema -> persistence-ports

persistence-ports -> persistence-local
persistence-ports -> persistence-convex

schema + persistence-ports + oauth + secrets -> domain

domain -> approvals/source-manager/engine
approvals/source-manager/engine -> mcp-gateway

domain/features -> rpc -> sdk -> ai-sdk-adapter

apps/pm      -> mcp-gateway + domain + persistence-local + rpc
apps/convex  -> mcp-gateway + domain + persistence-convex + rpc
apps/cli/web -> sdk
```

Rules:
- `schema` has no dependency on feature/runtime packages.
- `domain` depends on interfaces, not concrete state adapters.
- apps are leaves; packages do not import apps.
- packages expose effectful orchestration through services (`Context.Tag`), with Layers wiring implementations.

---

## 7) Local-lite PM architecture

`apps/pm` is the local daemon and source of hot truth.

Responsibilities:
- MCP endpoint surface
- source registration and status lifecycle
- approvals/input broker
- task orchestration and runtime execution coordination
- persistence (snapshot + event log)

### Persistence model

- Hot state: in-memory
- Durable: file-based
  - `snapshot.json`
  - `events.jsonl` (WAL)
  - `artifacts/` (compiled tool manifests)
  - secrets in secure store / dedicated protected file

Crash/restart behavior:
- Rehydrate from snapshot + events.
- Rebuild derived indexes in memory.
- Mark previously running tasks terminally with restart reason.

---

## 8) Data model strategy

Effect Schema is canonical (`packages/schema`).

Current scaffold includes:
- domain IDs (`src/ids.ts`)
- enums/common primitives
- model schemas:
  - profile, workspace
  - source, tool artifact
  - credential ref, oauth token
  - policy, approval
  - task run, sync state
  - event envelope
- local snapshot/WAL schemas in `persistence-local`

### Convex ID compatibility

IDs are now intentionally split by layer:
- **Domain IDs** live in `packages/schema` as portable branded IDs.
- **Convex table IDs** live in `packages/persistence-convex/src/convex-ids.ts` via `Id("table")` from `@executor-v2/confect`.

This keeps canonical schema backend-agnostic while preserving strict table-typed IDs inside the Convex adapter boundary.

---

## 9) Tooling, providers, and MCP surface

### Top-level model-facing tools

Keep top-level surface minimal:
- `execute` (primary)
- optional diagnostics (`health`, `version`) only if needed

### Configuration model

Executor config is handled as tool calls from inside `execute` via built-in namespace:
- `tools.executor.sources.add(...)`
- `tools.executor.sources.list(...)`
- `tools.executor.sources.remove(...)`
- other `tools.executor.*` controls as needed

No mandatory top-level `set_enabled` in v1 (remove/add is enough for initial UX).

### Provider architecture (source-agnostic)

Use a provider registry, not format-specific execution in core runtime.

- Each provider implements:
  - `discover(source) -> ToolManifest`
  - `invoke(call) -> ToolResult`
- Core runtime stays source-format agnostic; it resolves tool identity and dispatches to provider.
- Initial provider kinds:
  - `openapi`
  - `mcp`
  - `graphql`
  - `in_memory` (host-registered tools; AI-SDK style)
- Future source formats are added as new providers, without changing core execution semantics.

### Canonical tool descriptor

All providers publish into one canonical descriptor used by runtime and SDK:
- stable tool id
- display metadata (name, description)
- invocation metadata (kind + provider payload)
- availability metadata (`local_only` vs `remote_capable`)

Provider-specific details remain in a typed payload at the edge.

### Execution semantics

- Agent writes TS using `tools.*`.
- Runtime proxy resolves tool calls against the canonical registry.
- Provider receives invocation and returns canonical result envelope.
- Credentials/policies/approvals are applied server-side during invocation.

---

## 10) Dynamic source registration

Goal: user can ask the agent to use a service; agent can register the source through Executor tooling.

- Discovery itself may happen outside Executor (model/web).
- Registration happens via Executor control tools (`tools.executor.sources.add`).
- `source.kind` selects provider (`openapi`, `mcp`, `graphql`, etc.).
- In-memory tools are host-registered (runtime side), not persisted remote source records by default.

Registration flow states (networked providers):
- `draft -> probing -> auth_required -> connected | error`

Registration flow states (in-memory provider):
- `registered -> connected | error`

Auth handling:
- MCP: dynamic auth/OAuth detection, client registration where needed
- OpenAPI/GraphQL: inspect auth schemes, prompt for API key/OAuth when required

Secrets are entered through host UX, not model transcript.

---

## 11) Approvals and elicitation/input

Use one internal broker for human-required inputs:
- approval
- confirm
- form input
- secret input

### Capability-aware delivery

- If client supports MCP elicitation: inline prompt.
- If not: out-of-band path (tmux pane, local web, notifications).

### Terminal UX

For fullscreen terminal clients:
- tmux split/popup watcher
- auto-show when pending approvals appear
- auto-hide after queue drains (with debounce)

### Important boundary

Approval/input actions are **host UX callbacks**, not AI SDK model tools.

---

## 12) AI SDK strategy

API shape should be Executor session/adapters, not single-source helper APIs.

### Adapter-first target design

`Executor.create({ adapter })` with adapters such as:
- `inproc` (embedded runtime, no install)
- `pm` (local daemon transport)
- `remote` (Convex target transport)

### Public SDK shape

Primary operations:
- execute code
- register/list/remove sources
- register/list/remove in-memory tools (AI-SDK style)
- stream run status/results

Do not expose approval/input-response as model tools.
Use host callbacks (e.g. `onInputRequest`) instead.

---

## 13) Security posture

- PM binds to loopback by default.
- Secrets never pass through model args/transcripts.
- Credential references in state; secret values in secure store.
- Strict origin/token checks if hosted web talks to localhost target.
- Audit events store decisions/actions, not raw secret material.

---

## 14) Upgrade and sync

Primary path:
- `local-lite -> remote`

Optional reverse:
- `remote -> local-lite` export/backup

Sync principles:
- deterministic source identity
- idempotent imports
- explicit credential migration policy
- migration cursor/mapping persisted in local state

---

## 15) Rollout phases

### Phase 0: Architecture + contracts
- finalize package boundaries
- finalize schema model set and invariants
- define state/repository interfaces

### Phase 1: Local-lite core
- PM daemon skeleton
- file persistence (snapshot + WAL)
- execute path with runtime proxy integration
- provider registry + canonical tool descriptor
- basic source add/list/remove through `tools.executor.*`
- first provider slices: `openapi` + `in_memory`

### Phase 2: Input/approval UX
- InputBroker + pending state persistence
- tmux watcher + local web fallback
- capability-aware elicitation fallback paths

### Phase 3: Remote parity
- persistence-convex adapter and Convex app wiring
- shared RPC contracts for pm/convex
- target switching in CLI/web
- runtime/provider capability checks for local vs remote

### Phase 4: Sync + upgrades
- local->remote promotion pipeline
- idempotent mapping/cursor strategy
- conflict handling and dry-run reporting

### Phase 5: AI SDK adapters
- inproc adapter
- pm transport adapter
- remote transport adapter
- host callback API for inputs

---

## 16) Success criteria

- First successful `npx executor <agent>` run with no login in <2 minutes.
- No required database for local-lite mode.
- Same execution semantics across local and remote targets.
- Agent can add sources and execute against them in one flow.
- Provider-based execution works for at least `openapi` + `in_memory` in local-lite.
- Approval/input is usable in fullscreen terminal clients.

---

## 17) Non-goals (initial)

- Recreating all enterprise admin UX in local-lite.
- Exposing huge top-level tool catalogs to the model by default.
- Maintaining separate cloud vs self-host architecture branches.

---

## 18) Current scaffold status

Implemented in `v2` so far:
- monorepo app/package skeleton
- `confect` imported from quickhub
- schema package scaffold with Effect models and event envelope
- schema-driven runtime tool models (canonical descriptor + OpenAPI invocation/manifest)
- domain ID groundwork in `schema/src/ids.ts`
- Convex table ID groundwork in `persistence-convex/src/convex-ids.ts`
- shared persistence ports for `SourceStore` and `ToolArtifactStore`
- local persistence adapters for source/tool artifacts
- local-only snapshot/WAL contract and persistence implementation
- OpenAPI extraction + artifact refresh/reuse flow
- provider registry contracts and routing in `engine`
- OpenAPI provider invocation + in-memory provider path through registry
- local in-process JS runner with `tools.*` proxy dispatch
- Deno subprocess runtime path with IPC tool-call proxying and tests
- runtime adapter contract + registry scaffold in `engine` with mapped adapters (`local-inproc`, `deno-subprocess`, `cloudflare-worker-loader`)
- minimal PM execute lifecycle wired through MCP `executor.execute` -> runtime adapter registry (single run, no persisted run state yet)
- PM source control path wired through execute-time tools namespace (`tools.executor.sources.add/list/remove`) with local file persistence and OpenAPI probe/extraction
- source credential-aware OpenAPI invocation support via source config (`api_key`/`bearer` modes)
- vertical test: OpenAPI spec -> manifest -> execute code -> HTTP tool call
- service-first wiring (`Context.Tag` + Layer) across source manager and persistence/local runtime orchestration

Not implemented yet:
- approval adapter/state machine integration (pending/resume/deny persistence) in v2 runtime path
- provider/runtime conformance suite beyond current baseline tests (timeouts, cancellation, pending approval)
- Cloudflare worker loader adapter execution integration (current adapter is explicit scaffold/not-implemented)
- MCP/GraphQL provider implementations
- secure secret-store-backed credential persistence (current local MVP stores credential value in source config)
- full rpc/sdk adapter wiring and sync engine

---

## 19) Immediate next steps

1. Implement approval adapter contract with persisted pending/resume/deny flow for runtime tool calls.
2. Add provider/runtime conformance tests (invoke success/failure, timeout, pending approval, cancel).
3. Add Cloudflare worker loader adapter integration against the runtime adapter contract.
4. Move source credential persistence to secure store-backed refs (remove raw credential values from source config).
5. Extend PM execute lifecycle from single-run scaffold to persisted run state + streaming status.
