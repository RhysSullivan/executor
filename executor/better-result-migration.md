we are migrating to better-result for error handling.

the docs are avaliable in the readme of https://github.com/dmmulroy/better-result

- Goal: Move executor/core/convex error flow to better-result for recoverable failures, while keeping cleanup/irrecoverable defects as try/catch.
- Success criterion: Same behavior, clearer typed failures, and easier composition via Result and TaggedError.
- Constraint: No behavior regressions; keep existing fallbacks and best-effort paths intact.
  Phase 0 — Baseline and Contract
- Map current error behavior before edits:
  - executor: capture current try/catch counts and key failure paths.
  - Identify true “domain errors” vs. “defect exceptions” in each file.
- Define a shared error taxonomy for each boundary:
  - parse/normalization, external I/O, auth, tool execution, cache/db, scheduler/runtime, and JSON/network parsing.
- Add/confirm:
  - standard ErrorShape (TaggedError classes),
  - resultErrorMessage, unwrapError, and one boundary mapper for HTTP/route/Convex outputs.
- Approval gate: every new Result path must carry a typed error model (Result<T, AppErrorUnion>), not unknown.
  Phase 1 — Core Runtime Utilities (lowest blast radius first)
- Convert deterministic/small helpers first:
  - executor/packages/core/src/type-format.ts
  - executor/packages/core/src/runtimes/transpile.ts
  - executor/packages/core/src/runtimes/runtime-core.ts internal helpers like serialization.
- Add/adjust:
  - Result.try/Result.tryPromise,
  - Result.map/Result.mapError for error normalization,
  - catch blocks removed where they only wrap parse/IO failures into domain errors.
- Gate:
  - function signatures updated to return Result,
  - no semantic behavior change on success path,
  - unit tests updated/extended where error normalization changed.
    Phase 2 — Core Feature Pipelines
- Convert multi-step async flows with generator style where it improves clarity:
  - executor/packages/core/src/openapi-prepare.ts
  - executor/packages/core/src/tool/source-execution.ts
  - executor/packages/core/src/credential-providers.ts, tool_source_loaders/\*, other API prep/loaders.
- Refactor rule:
  - try only used when:
    - wrapping non-domain callback boundaries,
    - doing cleanup side effects,
    - preserving compatibility with external SDKs that throw.
- Gate:
  - each pipeline uses Result.gen/Result.await or explicit isErr checks for early return,
  - tagged errors are normalized at the pipeline boundary.
    Phase 3 — Convex Runtime/Auth/Tool Orchestration
- Convert orchestration-heavy files carefully, file-by-file:
  - executor/packages/convex/runtime/workspace_tools.ts
  - executor/packages/convex/runtime/tool_source_loading.ts
  - executor/packages/convex/runtime/tool_invocation.ts
  - MCP auth handler path in executor/packages/convex/http/mcp_handler.ts
- Do this in place with minimal contract changes:
  - preserve DB/auth semantics,
  - only change internal control flow to return Result until final response is built.
- Gate:
  - access-control and workspace behavior unchanged,
  - tests in access-controls.test.ts and related e2e suites still pass,
  - no untyped catch returning silent partial failures except cleanup.
    Phase 4 — Frontend Routes and Call Sites
- Finish existing edge conversions where already partial:
  - executor/apps/web/src/app/mcp/oauth/start/route.ts
  - executor/apps/web/src/app/mcp/oauth/callback/route.ts
  - executor/apps/web/src/app/mcp/oauth/detect/route.ts
  - executor/apps/web/src/lib/mcp/oauth-provider.ts
  - any remaining Result-ready route handlers.
- Standardize response shaping:
  - always keep user-facing messages stable,
  - map non-domain panics separately from expected recoverable failures.
- Gate:
  - UI flow unaffected,
  - no new thrown errors for expected validation problems.
    Phase 5 — Assistant + Sources Sweep
- After executor and convex are stable, apply selective clean-up:
  - assistant/packages/core/src/agent.ts
  - assistant/packages/bot/src/index.ts
  - sources modules where applicable.
- Gate:
  - only low-risk, high-signal conversions,
  - no broad style churn.
    Validation and “complete” criteria
- Static checks:
  - bun run typecheck
  - bun run test
  - bun run test:executor
  - bun run test:assistant
  - bun run knip
- Semantic checks:
  - All converted paths preserve success output and existing logging/metrics signals.
  - panic use remains only for invariant/defect cases, not domain failures.
  - Error payloads at external boundaries remain JSON-serializable and actionable.
- Completion gate:
  - No panic introduced where a recoverable Err was expected,
  - No new behavior regressions in OAuth/tooling execution/authz flows,
  - Migration notes in a tracking doc include every touched file + acceptance result (pass/fail).
