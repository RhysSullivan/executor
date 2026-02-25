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

---

## 3) Product modes and targets

### Modes

- **local-lite**: PM daemon + in-memory hot state + file persistence. No DB.
- **remote**: Convex-backed target (applies to both cloud and self-hosted).

### Key simplification

- `cloud` and `self-hosted` are not separate architecture branches.
- They are both **remote Convex targets**; only URL/auth/deployment ownership differs.

---

## 4) Control + execution model

### Control role (conceptual)

Control includes source registry, policies, approvals/input workflow, identity/link state, and sync metadata.

- In local-lite: handled by `apps/pm`.
- In remote: handled by Convex + web stack.

### Execution role

Execution remains the runtime engine that runs generated TypeScript and calls `tools.*` via proxy invocation.

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
- snapshot/event schemas

### Convex ID compatibility

IDs are now intentionally split by layer:
- **Domain IDs** live in `packages/schema` as portable branded IDs.
- **Convex table IDs** live in `packages/persistence-convex/src/convex-ids.ts` via `Id("table")` from `@executor-v2/confect`.

This keeps canonical schema backend-agnostic while preserving strict table-typed IDs inside the Convex adapter boundary.

---

## 9) Tooling and MCP surface

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

### Execution semantics

- Agent writes TS using `tools.*`.
- Runtime proxy resolves tool calls.
- Credentials/policies/approvals are applied server-side during invocation.

---

## 10) Dynamic source registration

Goal: user can ask the agent to use a service; agent can register the source through Executor tooling.

- Discovery itself may happen outside Executor (model/web).
- Registration happens via Executor control tools (`tools.executor.sources.add`).

Registration flow states:
- `draft -> probing -> auth_required -> connected | error`

Auth handling:
- MCP: dynamic auth/OAuth detection, client registration where needed
- OpenAPI: inspect security schemes, prompt for API key if required

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
- basic source add/list/remove through `tools.executor.*`

### Phase 2: Input/approval UX
- InputBroker + pending state persistence
- tmux watcher + local web fallback
- capability-aware elicitation fallback paths

### Phase 3: Remote parity
- persistence-convex adapter and Convex app wiring
- shared RPC contracts for pm/convex
- target switching in CLI/web

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
- schema package scaffold with Effect models
- domain ID groundwork in `schema/src/ids.ts`
- Convex table ID groundwork in `persistence-convex/src/convex-ids.ts`

Not implemented yet:
- runtime wiring, adapters, rpc handlers, PM behavior, sync engine

---

## 19) Immediate next steps

1. Define `persistence-ports` interfaces against current schema models.
2. Implement minimal `persistence-local` snapshot + event log codec.
3. Wire a minimal `apps/pm` execute flow (single run lifecycle).
4. Add first `tools.executor.sources.add/list/remove` control operations.
5. Add basic InputBroker contract (without full UI).
