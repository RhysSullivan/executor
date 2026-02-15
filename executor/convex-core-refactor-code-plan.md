# Convex/Core Greenfield Refactor Plan (Code-Only)

## Scope
- Keep all Convex schema ownership in `executor/packages/convex/schema.ts`.
- Treat `executor/packages/core` as the home for pure transformation/domain logic.
- Keep `executor/packages/convex` as orchestration boundary: DB writes/reads, authz, scheduler, side effects.
- Do not add script/docs-only changes in this pass; only code changes are planned.

## Phase 1 — RPC Boundary (read/write split only)

### 1.1 Add RPC barrel directories
- Add:
  - `executor/packages/convex/rpcs/public/index.ts`
  - `executor/packages/convex/rpcs/internal/index.ts`
- Add optional domain files under each folder (no behavior logic).

### 1.2 Move public RPC declarations into `rpcs/public`
- Move every public `query`, `mutation`, `action` currently declared outside `rpcs/public` into the public barrel files.
- Start with these likely sources:
  - `executor/packages/convex/workspace.ts`
  - `executor/packages/convex/app.ts`
  - `executor/packages/convex/executor.ts`
  - `executor/packages/convex/executorNode.ts`
  - `executor/packages/convex/runtime/*`
  - `executor/packages/convex/task/*`
  - `executor/packages/convex/database.ts`
- Keep only pure functions/helpers in origin files and export/import through public barrel.

### 1.3 Move internal RPC declarations into `rpcs/internal`
- Move all `internalMutation`, `internalAction`, `internalQuery` declarations to:
  - `executor/packages/convex/rpcs/internal/*`
- Keep orchestration logic in helper files and call them from these declarations.

### 1.4 Thin Convex entrypoints
- Refactor:
  - `executor/packages/convex/http.ts`
  - `executor/packages/convex/app.ts`
  - `executor/packages/convex/workspace.ts`
- Convert these to wiring/re-export modules for the RPC barrels.

## Phase 2 — Extraction: tool path/discovery pure functions

### 2.1 Move tool path utilities
- Move pure path utilities from:
  - `executor/packages/convex/runtime/tool_paths.ts`
- To:
  - `executor/packages/core/src/tool-discovery/tool-paths.ts`

### 2.2 Split `workspace_tools.ts`
- In `executor/packages/convex/runtime/workspace_tools.ts` separate:
  - Pure parsing/normalization/formatting functions -> `executor/packages/core/src/tool-discovery/workspace-tools.ts`
  - DB/credential/scheduler/cache-dependent functions -> remain in Convex.

### 2.3 Move pure call-resolution helpers
- Move deterministic formatting/resolution helpers from:
  - `executor/packages/convex/runtime/tool_call_resolution.ts`
- To:
  - `executor/packages/core/src/tool-discovery/tool-call-resolution.ts`
- Keep only stateful invocation logic in Convex runtime.

## Phase 3 — OpenAPI pipeline split

### 3.1 Keep pure OpenAPI transforms in core
- Ensure and consolidate pure modules under core:
  - `executor/packages/core/src/openapi-prepare.ts`
  - `executor/packages/core/src/openapi/tool-builder.ts`
  - `executor/packages/core/src/openapi/schema-hints.ts`

### 3.2 Keep side-effect pipeline in Convex
- Keep/adjust Convex-side orchestration + storage in:
  - `executor/packages/convex/runtime/tool_source_loading.ts`
  - related source-loading callers in `executor/packages/convex/runtime/*`
- Refactor callers so Convex passes DB/context to pure core functions, then persists outputs.

## Phase 4 — Core type boundary cleanup

### 4.1 Remove Convex type leakage from core modules
- Refactor:
  - `executor/packages/core/src/function-builders.ts`
  - `executor/packages/core/src/identity.ts`
  - `executor/packages/core/src/types.ts`
- Replace direct Convex runtime types (`_generated` docs/ids where possible) with domain contracts.

### 4.2 Add boundary adapters in Convex
- Add/expand:
  - `executor/packages/convex/adapters/contracts.ts`
- Move/centralize conversion helpers:
  - Convex `Id` <-> domain IDs
  - Convex `Doc`-shaped runtime records <-> Core DTOs

### 4.3 Update call sites to use adapters
- Update all Convex <-> Core calls to pass/receive adapter-shaped values.
- Ensure no core file imports Convex internal generated modules for general logic.

## Phase 5 — Final extraction sweep and cleanup

### 5.1 Move additional pure utilities discovered in `runtime`/`task`
- Audit:
  - `executor/packages/convex/runtime/*`
  - `executor/packages/convex/task/*`
- For each pure function file, move to `executor/packages/core/src/*` and keep only orchestration-side effects in Convex.

### 5.2 Normalize imports after each move
- Replace moved imports to use core modules.
- Keep any DB, auth, scheduler, or external-call side effects behind Convex modules.

### 5.3 Delete empty/obsolete runtime modules
- Remove Convex files reduced to no logic after extraction.
- Keep small proxy wrappers only when needed to avoid breaking imports.

## Mandatory implementation order
1. `Phase 1` (RPC boundary first)
2. `Phase 2` (tool discovery path split)
3. `Phase 3` (OpenAPI split)
4. `Phase 4` (type boundary cleanup)
5. `Phase 5` (final sweep)

## Concrete acceptance criteria (code-level)
- All RPC declarations are in `executor/packages/convex/rpcs/public/*` or `executor/packages/convex/rpcs/internal/*`.
- `executor/packages/convex/runtime/tool_paths.ts` is either removed or only contains Convex-specific wrappers.
- `executor/packages/convex/runtime/workspace_tools.ts` has only stateful/runtime logic.
- OpenAPI parsing/type transformation logic has no Convex DB/auth/scheduler side effects.
- Core packages can typecheck without `executor/packages/convex/_generated/*` imports for non-boundary modules.
- Any Convex/Core boundary exchange goes through adapter conversion points.
