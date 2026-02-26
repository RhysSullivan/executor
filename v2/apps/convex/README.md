# app-convex

Convex remote server app scaffold for Executor v2.

Current scaffold includes:
 Convex schema wiring at `convex/schema.ts`, sourced from `@executor-v2/persistence-convex`
 MCP HTTP endpoint at `convex/http.ts` and `convex/mcp.ts`, wired through a run client
 runtime callback endpoints at `POST /runtime/tool-call` and `POST /v1/runtime/tool-call`
 action-level callback handler scaffold in `convex/runtimeCallbacks.ts`
