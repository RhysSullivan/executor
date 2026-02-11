// ── Runtime ID constants ──────────────────────────────────────────────────────

export const LOCAL_BUN_RUNTIME_ID = "local-bun";
export const CLOUDFLARE_WORKER_LOADER_RUNTIME_ID = "cloudflare-worker-loader";

const KNOWN_RUNTIME_IDS = new Set([
  LOCAL_BUN_RUNTIME_ID,
  CLOUDFLARE_WORKER_LOADER_RUNTIME_ID,
]);

export function isKnownRuntimeId(runtimeId: string): boolean {
  return KNOWN_RUNTIME_IDS.has(runtimeId);
}

// ── Cloudflare Worker Loader config ──────────────────────────────────────────

export interface CloudflareWorkerLoaderConfig {
  /** The URL of the CF host worker's /v1/runs endpoint. */
  runUrl: string;
  /** Shared-secret bearer token for authenticating with the host worker. */
  authToken: string;
  /** HTTP request timeout in ms (how long we wait for the host worker to respond). */
  requestTimeoutMs: number;
  /** The Convex site URL that the CF host worker calls back to for tool invocations. */
  callbackBaseUrl: string;
  /** Internal auth token that the CF host worker uses when calling back. */
  callbackAuthToken: string;
}

/**
 * Returns true if all required env vars for the Cloudflare Worker Loader
 * runtime are present.
 */
export function isCloudflareWorkerLoaderConfigured(): boolean {
  return Boolean(
    process.env.CLOUDFLARE_SANDBOX_RUN_URL
    && process.env.CLOUDFLARE_SANDBOX_AUTH_TOKEN,
  );
}

/**
 * Reads Cloudflare Worker Loader config from environment variables.
 * Throws if required vars are missing.
 */
export function getCloudflareWorkerLoaderConfig(): CloudflareWorkerLoaderConfig {
  const runUrl = process.env.CLOUDFLARE_SANDBOX_RUN_URL;
  const authToken = process.env.CLOUDFLARE_SANDBOX_AUTH_TOKEN;

  if (!runUrl || !authToken) {
    throw new Error(
      "Cloudflare Worker Loader runtime requires CLOUDFLARE_SANDBOX_RUN_URL and CLOUDFLARE_SANDBOX_AUTH_TOKEN",
    );
  }

  // The callback URL is the Convex site URL where the internal runs API lives.
  // The CF host worker will POST to {callbackBaseUrl}/internal/runs/{runId}/tool-call
  const callbackBaseUrl = process.env.CONVEX_SITE_URL ?? process.env.CONVEX_URL;
  if (!callbackBaseUrl) {
    throw new Error(
      "Cloudflare Worker Loader runtime requires CONVEX_SITE_URL or CONVEX_URL for tool-call callbacks",
    );
  }

  const callbackAuthToken = process.env.EXECUTOR_INTERNAL_TOKEN;
  if (!callbackAuthToken) {
    throw new Error(
      "Cloudflare Worker Loader runtime requires EXECUTOR_INTERNAL_TOKEN for authenticated tool-call callbacks",
    );
  }

  const requestTimeoutMs = Number(
    process.env.CLOUDFLARE_SANDBOX_REQUEST_TIMEOUT_MS ?? "90000",
  );

  return {
    runUrl,
    authToken,
    requestTimeoutMs,
    callbackBaseUrl,
    callbackAuthToken,
  };
}
