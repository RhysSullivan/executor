# Executor v2 Plan

Reference implementations and inspiration for this plan:
`../AnswerOverflow`
`../quickhub`
`../create-epoch-app`
## 1) Why v2 exists

Executor today is optimized for enterprise/team correctness (workspaces, org flows, cloud control), but has too much friction for per-user adoption.

v2 changes the default:

- First run is local and immediate (`npx executor <agent>` works fast).
- No external database dependency in local-lite mode.
- Cloud/self-host are upgrade targets, not prerequisites.
- One architecture for local and remote via shared contracts and thin adapters.

---

## 2) Product principles

1. Local-first
   - User gets value without login, org setup, or web onboarding.
2. One mental model
   - Same execution semantics across local and remote.
3. Schema-first
   - Effect Schema is canonical for domain and persistence contracts.
4. Execute-first
   - Keep top-level model-facing surface minimal (`execute` first).
5. Service-first architecture
   - Effect orchestration is exposed via services and layers.
6. Progressive complexity
   - Advanced control and infra stay out of the default happy path.

---

## 3) The architecture (locked)

v2 is split into three planes. This is the key simplification.

### Execution plane

Runs code and resolves `tools.*` calls.

- run lifecycle
- runtime dispatch
- tool invocation pipeline
- approvals/policy enforcement
- credential resolution for tool calls

### Control plane

Mutates and queries executor configuration/state.

- source registration/removal
- tool artifact refresh/rebuild
- policy management
- sync metadata

Control is optional capability, not required for execute-only environments.

### Transport plane

How clients talk to executor.

- MCP server/gateway
- OpenAPI control API
- AI SDK tool bridge

Transport does not own core execution semantics.

---

## 4) Core contracts

We do not need a mandatory public `new Executor()` product surface.

Primary internal shape is a kernel service (name can vary, e.g. `createExecutorKernel`).

### Kernel contract

- `execute(request) -> terminal result` (or async run id if configured)
- `handleRuntimeToolCall(call) -> encoded tool-call result`
- optional `control` capability

### Adapter contracts

- RuntimeDispatchAdapter
  - only decides where code runs (`local-inproc`, `deno-subprocess`, `cloudflare-worker-loader`)
- ToolInvocationService
  - resolves tool path and invokes tool with policy/approval checks
- CredentialResolver
  - resolves credential headers during tool invocation callback
- ControlService (optional)
  - source/tool/policy management commands

Important boundary:
- Credential resolution is not part of runtime dispatch.
- Credential resolution happens in callback-time tool invocation.

---

## 5) Modes and targets

### Modes

- local-lite: Runtime Host daemon + in-memory hot state + file durability
- remote: SQL-backed target (Postgres remote, SQLite local)

### Runtime targets

- `deno-subprocess`: local secure default
- `cloudflare-worker-loader`: remote production default
- `node:vm`: explicit unsafe/dev fallback only

---

## 6) Local and cloud runtime flows

### Local flow

1. Request starts run (`execute`).
2. Runtime dispatch executes locally (`inproc` or `deno-subprocess`).
3. Runtime `tools.*` call hits local callback handler.
4. Callback handler invokes shared tool invocation pipeline:
   - resolve tool
   - policy check
   - approval gating
   - credential resolution (if needed)
   - provider invoke
5. Runtime resumes and completes.
6. Run/events persisted locally.

### Remote flow (SQL + Cloudflare worker loader)

1. Request starts run in control-plane API.
2. Runtime dispatch executes through configured runtime adapter.
3. Worker `tools.*` call hits runtime callback action (`handleToolCall`).
4. Callback action invokes shared tool invocation pipeline:
   - resolve tool
   - policy check
   - approval gating
   - credential resolution from SQL-backed state/secret stores
   - provider invoke
5. Worker resumes and returns terminal status.
6. Control plane marks run terminal and emits events.

Serverless note:
- There is no long-lived in-memory `onToolCall` loop in cloud.
- Callback requests are stateless/durable and reconstruct context per request.

---

## 7) Blocking and non-blocking execution

Both are first-class and share one implementation path.

- Async canonical path:
  - submit run -> return `runId`
  - query/watch run status -> terminal result
- Blocking convenience path:
  - submit run
  - wait/watch internally
  - return terminal result

This is mostly transport/API behavior; core runtime pipeline stays the same.

---

## 8) MCP, OpenAPI, and AI SDK strategy

### MCP

MCP remains the main execution transport surface.

Top-level model-facing tools stay minimal:
- `execute` (primary)
- optional diagnostics (`health`, `version`)

### Control API

Control is exposed through Executor OpenAPI contracts.

- Host/app control calls should use control API directly.
- Model control calls can use `tools.executor.*` inside `execute` code.
- Both host and model control paths must hit the same underlying control handlers.

### AI SDK

AI SDK is a bridge over executor execute capability.

- `toAiSdkTools(executorLike)` maps to regular AI SDK tools.
- Local and remote both work if they expose `execute(...)` semantics.
- If client is MCP-native, AI SDK bridge is optional.

AI SDK should not become a second control-plane abstraction.

---

## 9) Tooling and provider model

Provider registry is canonical.

Each provider implements:
- discover(source) -> ToolManifest
- invoke(call) -> ToolResult

Initial provider kinds:
- `openapi`
- `in_memory`
- `mcp` (planned)
- `graphql` (planned)

Canonical descriptor includes:
- stable tool id/path
- display metadata
- invocation metadata
- capability metadata

Provider-specific details remain in provider payload types.

---

## 10) Persistence and registry model

Persistence is source of truth. Runtime registry is derived.

### Persisted

- sources
- tool artifacts/manifests
- runs/events
- approvals/policies
- credential references (secret values in secure backing store)

### Derived

- in-memory runnable tool index/registry
- discovery indexes

Mutation rule:
1. persist authoritative record
2. refresh/rebuild derived artifact/index
3. bump registry version

Run rule:
- each run snapshots tool registry version at start
- in-flight runs keep snapshot semantics
- new runs see newest version

---

## 11) Approval and secret boundaries

Approvals/input are host UX concerns, not model tools.
- approval
- confirm
- form input
- secret input
Secrets/credentials:
- never emitted to model transcript
- resolved server-side during invocation
- converted to headers/token material for provider calls

---

## 12) Security posture
- Runtime Host binds to loopback by default.
- Runtime callbacks require internal token validation.
- Secrets do not pass through model args/transcripts.
- Credential refs in state; secret values in secure stores.
- Audit events store actions/decisions, not raw secret material.

---

## 13) Monorepo shape (Executor v2)

```text
v2/
  apps/
    cli/
    runtime-host/
    web/
  packages/
    schema/
    state-contracts/
    persistence-sql/
    domain/
    approvals/
    source-manager/
    control-plane/
    engine/
    mcp-gateway/
    oauth/
    secrets/
    sync/
    sdk/
    ai-sdk-adapter/
```

Planned follow-up split (after behavior stabilizes):
- runtime adapters as dedicated packages
- transport adapters as dedicated packages

---

## 14) Dependency direction

```text
schema -> state-contracts

state-contracts -> persistence-sql

schema + state-contracts + oauth + secrets -> domain
domain -> approvals/source-manager/engine
source-manager + schema -> control-plane
approvals/source-manager/engine -> mcp-gateway
domain/features -> sdk -> ai-sdk-adapter

packages/control-plane-runtime -> mcp-gateway + domain + persistence-sql + control-plane
packages/api-http             -> management-api (request/response routing)
apps/web                       -> management-api + persistence-sql + control-plane routes
apps/cli                       -> sdk + api-http + control-plane-runtime
```
Rules:
- `schema` is backend-agnostic.
- apps are leaves.
- packages do not import apps.
- orchestration services are injected via interfaces/tags/layers.

---

## 15) Rollout phases

### Phase 0: lock contracts

- finalize kernel + adapter contracts
- finalize execution/control/transport boundaries
- align package names/imports to current v2 structure

### Phase 1: local-lite execute vertical slice

- Runtime Host execute path with persisted run lifecycle
- runtime callback path wired through shared invocation service
- openapi + in_memory providers

### Phase 2: control vertical slice

- source add/list/remove via control handlers
- same handlers callable from host control API and `tools.executor.*`
- artifact refresh + registry versioning

### Phase 3: approvals and credentials hardening

- persisted pending/resume/deny flow
- capability-aware UX fallbacks
- callback-time credential resolver implementations (local + remote SQL)

### Phase 4: remote parity

- SQL adapter wiring for kernel and control
- cloudflare loader integration through runtime dispatch adapter
- parity/conformance suite across local and remote

### Phase 5: transport polish

- MCP surface stabilization
- OpenAPI control surface stabilization
- AI SDK bridge (`toAiSdkTools`) and docs/examples

---

## 16) Success criteria

- First successful local run with no login in under 2 minutes.
- No required DB in local-lite mode.
- Same execution semantics across local and remote.
- Callback-time approvals/policy/credentials work in both local and cloud.
- Control operations are callable both by host API and from inside execute namespace.
- Blocking and non-blocking execution both available via shared run pipeline.

---

## 17) Non-goals (initial)

- Recreating full enterprise admin UX in local-lite.
- Expanding model-facing top-level tool catalog by default.
- Maintaining separate cloud vs self-host architecture branches.
- Coupling runtime adapters with credential/secrets responsibilities.

---

## 18) Current scaffold status

Implemented in `v2` so far:
- monorepo app/package skeleton
- schema package scaffold with Effect models/event envelope
- shared state contracts for source/tool artifacts
- SQL adapters for source/tool artifacts + snapshot/event-log state store
- source manager OpenAPI extraction + artifact refresh/reuse
- provider registry contracts and routing in engine
- OpenAPI provider invocation + in-memory provider path through registry
- local in-process JS runner with `tools.*` proxy
- Deno subprocess runtime path with IPC tool-call proxying and tests
- runtime adapter contract + registry scaffold
- Runtime Host execute lifecycle scaffold via MCP execute path

Still missing:

- fully wired control handlers (`tools.executor.sources.add/list/remove`) end-to-end
- shared tool invocation service wired with persisted approval lifecycle in v2 path
- cloudflare-worker-loader runtime adapter implementation in v2 runtime path
- parity conformance tests for runtime/provider/pending-approval/cancel flows
- full openapi/sdk/ai-sdk adapter wiring and usage examples

---

## 19) Immediate next steps

1. Land shared `ToolInvocationService` contract in v2 and wire Runtime Host execute callback path through it.
2. Add `CredentialResolver` interfaces and local/remote implementations; integrate at invocation-time only.
3. Implement control handlers for sources (`add/list/remove`) and route both host API and `tools.executor.*` through same code path.
4. Implement cloudflare-worker-loader runtime dispatch adapter in v2 and wire callback endpoints.
5. Add run API split for async + blocking convenience (`submit` + `wait/watch`) without duplicating execution logic.
6. Add conformance tests that run same scenarios across local and remote adapters.
