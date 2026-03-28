import * as Effect from "effect/Effect";

import type {
  SourceAuthInference,
  SourceDiscoveryResult,
  SourceProbeAuth,
} from "./discovery-models";

export const SOURCE_DISCOVERY_TIMEOUT_MS = 5_000;

export type HttpProbeResponse = {
  status: number;
  headers: Readonly<Record<string, string>>;
  text: string;
};

export type SourceDiscoveryProbeInput = {
  normalizedUrl: string;
  headers: Readonly<Record<string, string>>;
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const asString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

export const trimOrNull = (value: string | null | undefined): string | null => {
  if (value == null) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const defaultNameFromEndpoint = (endpoint: string): string =>
  new URL(endpoint).hostname;

export const namespaceFromSourceName = (name: string): string => {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "");

  return normalized.length > 0 ? normalized : "source";
};

export const normalizeSourceDiscoveryUrl = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error("Source URL is required");
  }

  const parsed = new URL(trimmed);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Source URL must use http or https");
  }

  return parsed.toString();
};

export const unsupportedAuthInference = (
  kind: SourceAuthInference["suggestedKind"],
  input: Omit<SourceAuthInference, "suggestedKind" | "supported">,
): SourceAuthInference => ({
  ...input,
  suggestedKind: kind,
  supported: false,
});

export const supportedAuthInference = (
  kind: Extract<SourceAuthInference["suggestedKind"], "none" | "bearer" | "oauth2">,
  input: Omit<SourceAuthInference, "suggestedKind" | "supported">,
): SourceAuthInference => ({
  ...input,
  suggestedKind: kind,
  supported: true,
});

export const unknownAuthInference = (reason: string): SourceAuthInference => ({
  suggestedKind: "unknown",
  confidence: "low",
  supported: false,
  reason,
  headerName: null,
  prefix: null,
  parameterName: null,
  parameterLocation: null,
  oauthAuthorizationUrl: null,
  oauthTokenUrl: null,
  oauthScopes: [],
});

export const noneAuthInference = (
  reason: string,
  confidence: SourceAuthInference["confidence"] = "high",
): SourceAuthInference =>
  supportedAuthInference("none", {
    confidence,
    reason,
    headerName: null,
    prefix: null,
    parameterName: null,
    parameterLocation: null,
    oauthAuthorizationUrl: null,
    oauthTokenUrl: null,
    oauthScopes: [],
  });

export const parseChallengeAuthInference = (
  headers: Readonly<Record<string, string>>,
  fallbackReason: string,
): SourceAuthInference => {
  const challenge = headers["www-authenticate"] ?? headers["WWW-Authenticate"];
  if (!challenge) {
    return unknownAuthInference(fallbackReason);
  }

  const normalized = challenge.toLowerCase();
  if (normalized.includes("bearer")) {
    return supportedAuthInference("bearer", {
      confidence: normalized.includes("realm=") ? "medium" : "low",
      reason: `Derived from HTTP challenge: ${challenge}`,
      headerName: "Authorization",
      prefix: "Bearer ",
      parameterName: null,
      parameterLocation: null,
      oauthAuthorizationUrl: null,
      oauthTokenUrl: null,
      oauthScopes: [],
    });
  }

  if (normalized.includes("basic")) {
    return unsupportedAuthInference("basic", {
      confidence: "medium",
      reason: `Derived from HTTP challenge: ${challenge}`,
      headerName: "Authorization",
      prefix: "Basic ",
      parameterName: null,
      parameterLocation: null,
      oauthAuthorizationUrl: null,
      oauthTokenUrl: null,
      oauthScopes: [],
    });
  }

  return unknownAuthInference(fallbackReason);
};

export const probeHeadersFromAuth = (
  probeAuth: SourceProbeAuth | null | undefined,
): Record<string, string> => {
  if (probeAuth == null || probeAuth.kind === "none") {
    return {};
  }

  if (probeAuth.kind === "headers") {
    return { ...probeAuth.headers };
  }

  if (probeAuth.kind === "basic") {
    return {
      Authorization: `Basic ${Buffer.from(`${probeAuth.username}:${probeAuth.password}`).toString("base64")}`,
    };
  }

  return {
    [trimOrNull(probeAuth.headerName) ?? "Authorization"]: `${probeAuth.prefix ?? "Bearer "}${probeAuth.token}`,
  };
};

const responseHeadersRecord = (response: Response): Record<string, string> => {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
};

export const executeHttpProbe = (input: {
  method: "GET" | "POST";
  url: string;
  headers?: Readonly<Record<string, string>>;
  body?: string;
}): Effect.Effect<HttpProbeResponse, Error, never> =>
  Effect.tryPromise({
    try: async () => {
      let response: Response;
      try {
        response = await fetch(input.url, {
          method: input.method,
          headers: input.headers,
          body: input.body,
          signal: AbortSignal.timeout(SOURCE_DISCOVERY_TIMEOUT_MS),
        });
      } catch (cause) {
        if (
          cause instanceof Error
          && (cause.name === "AbortError" || cause.name === "TimeoutError")
        ) {
          throw new Error(`Source discovery timed out after ${SOURCE_DISCOVERY_TIMEOUT_MS}ms`);
        }
        throw cause;
      }

      return {
        status: response.status,
        headers: responseHeadersRecord(response),
        text: await response.text(),
      } satisfies HttpProbeResponse;
    },
    catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
  });

export const tryParseJson = (value: string): unknown => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
};

export const fallbackSourceDiscoveryResult = (
  normalizedUrl: string,
): SourceDiscoveryResult => {
  const endpoint = normalizedUrl;
  const name = defaultNameFromEndpoint(endpoint);
  return {
    detectedKind: "unknown",
    confidence: "low",
    endpoint,
    specUrl: null,
    name,
    namespace: namespaceFromSourceName(name),
    transport: null,
    authInference: unknownAuthInference(
      "Could not infer source kind or auth requirements from the provided URL",
    ),
    toolCount: null,
    warnings: [
      "Could not confirm whether the URL matches any registered source plugin.",
    ],
  };
};
