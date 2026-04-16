// Stub for `cloudflare:workers` used by node-pool integration tests.
// Production code paths that read real bindings (Hyperdrive, LOADER,
// Durable Objects) aren't exercised by these tests — only the
// `env.HYPERDRIVE` fallback in services/db.ts, and that short-circuits
// when DATABASE_URL is set (which it always is in tests).

export const env: Record<string, unknown> = {};
export class WorkerEntrypoint {}
export class DurableObject {}
export class WorkflowEntrypoint {}
export const exports: Record<string, unknown> = {};
