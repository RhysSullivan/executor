/**
 * Eden Treaty client for the assistant server.
 */

import { type Treaty, treaty } from "@elysiajs/eden";
import type { App } from "./routes";

export type Client = ReturnType<typeof treaty<App>>;

export function createClient(baseUrl: string): Client {
  return treaty<App>(baseUrl);
}

export class ApiError {
  readonly _tag = "ApiError";
  constructor(readonly status: number, readonly value: unknown) {}
}

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

export type { App } from "./routes";
