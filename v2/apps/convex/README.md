# app-convex

Convex remote server app scaffold for Executor v2.

Current scaffold includes:
- Convex schema wiring at `convex/schema.ts`, sourced from `@executor-v2/persistence-convex`
- bare-minimum MCP HTTP endpoint exposing `executor.execute` (currently returns not-wired error) at `convex/http.ts` and `convex/mcp.ts`
