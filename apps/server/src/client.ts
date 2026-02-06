/**
 * Eden Treaty client for OpenAssistant server.
 *
 * Provides a type-safe client that can be consumed by:
 * - The Discord bot (Reacord) via Effect wrappers
 * - Any other TypeScript client
 *
 * Usage:
 *   import { createClient, effect } from "@openassistant/server/client"
 *
 *   // Plain Eden Treaty (Promise-based)
 *   const api = createClient("http://localhost:3000")
 *   const { data, error } = await api.api.tasks.post({ prompt: "...", requesterId: "..." })
 *
 *   // Effect-wrapped
 *   const result = yield* effect(api.api.tasks.post({ prompt: "...", requesterId: "..." }))
 */

import { type Treaty, treaty } from "@elysiajs/eden";
import type { App } from "./routes.js";

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

export type Client = ReturnType<typeof treaty<App>>;

export interface ClientConfig {
  /** Base fetch configuration. */
  fetch?: Omit<RequestInit, "headers" | "method">;
}

/**
 * Create a typed Eden Treaty client for the OpenAssistant server.
 */
export function createClient(
  baseUrl: string,
  config?: ClientConfig,
): Client {
  return treaty<App>(baseUrl, {
    ...(config?.fetch ? { fetch: config.fetch } : {}),
  });
}

// ---------------------------------------------------------------------------
// Effect wrapper (lazy import to avoid hard dep for non-Effect consumers)
// ---------------------------------------------------------------------------

/**
 * Error from an Eden Treaty call.
 */
export class ApiError {
  readonly _tag = "ApiError";
  constructor(
    readonly status: number,
    readonly value: unknown,
  ) {}
}

/**
 * Wrap an Eden Treaty call in an Effect.
 *
 * Converts the { data, error } pattern into Effect's success/failure.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { createClient, effectify } from "@openassistant/server/client"
 *
 * const api = createClient("http://localhost:3000")
 * const program = Effect.gen(function* () {
 *   const task = yield* effectify(api.api.tasks.post({ prompt: "hello", requesterId: "user_1" }))
 *   // task is typed as { taskId: string, status: TaskStatus }
 * })
 * ```
 */
export async function unwrap<T extends Record<number, unknown>>(
  treatyCall: Promise<Treaty.TreatyResponse<T>>,
): Promise<Treaty.Data<Treaty.TreatyResponse<T>>> {
  const response = await treatyCall;

  if (response.error) {
    const err = response.error as unknown;
    if (err && typeof err === "object" && "status" in err) {
      throw new ApiError(
        (err as { status: number }).status,
        "value" in err ? (err as { value: unknown }).value : err,
      );
    }
    throw new ApiError(0, err);
  }

  if (response.data !== undefined) {
    return response.data as Treaty.Data<Treaty.TreatyResponse<T>>;
  }

  throw new ApiError(0, "No data returned from API");
}

// ---------------------------------------------------------------------------
// Re-export types from routes
// ---------------------------------------------------------------------------

export type { App } from "./routes.js";
