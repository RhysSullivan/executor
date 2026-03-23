import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  type CompleteSourceOAuthResult,
  type ConnectSourcePayload,
  type CreateSourcePayload,
  type InstanceConfig,
  type Loadable,
  type StartSourceOAuthPayload,
  type SecretListItem,
  type Source,
  type UpdateSourcePayload,
  useCreateSecret,
  useCreateSource,
  useConnectSource,
  useInvalidateExecutorQueries,
  useInstanceConfig,
  useRefreshSecrets,
  useRemoveProviderAuthGrant,
  useRemoveSource,
  useSecrets,
  useSources,
  useStartSourceOAuth,
  useSource,
  useUpdateSource,
} from "@executor/react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { LoadableBlock } from "../components/loadable";
import { SourceNotFoundState } from "../components/source-not-found-state";
import { SourceFavicon } from "../components/source-favicon";
import {
  IconArrowLeft,
  IconPencil,
  IconPlus,
  IconSpinner,
  IconTrash,
} from "../components/icons";
import { cn } from "../lib/utils";
import {
  asMcpRemoteTransportValue,
  defaultMcpRemoteTransportFields,
  defaultMcpStdioTransportFields,
  setMcpTransportFieldsTransport,
  type McpRemoteTransportFields,
  type McpStdioTransportFields,
  type McpTransportFields,
  type McpTransportValue,
} from "./mcp-transport-state";
import { parseJsonStringArray, parseJsonStringMap } from "./json-form";
import { sourceTemplates, type SourceTemplate } from "./source-templates";
import { getDomain } from "tldts";

type StatusBannerState = {
  tone: "info" | "success" | "error";
  text: string;
};

type SourceOAuthPopupMessage =
  | {
      type: "executor:oauth-result";
      ok: true;
      sessionId: string;
      auth: CompleteSourceOAuthResult["auth"];
    }
  | {
      type: "executor:oauth-result";
      ok: false;
      sessionId: string | null;
      error: string;
    }
  | {
      type: "executor:source-oauth-result";
      ok: true;
      sourceId: string;
    }
  | {
      type: "executor:source-oauth-result";
      ok: false;
      error: string;
    };

type OAuthPopupResultMessage = Extract<
  SourceOAuthPopupMessage,
  { type: "executor:oauth-result" }
>;

const SOURCE_OAUTH_POPUP_RESULT_TIMEOUT_MS = 2 * 60_000;
const SOURCE_OAUTH_POPUP_RESULT_STORAGE_KEY_PREFIX = "executor:oauth-result:";

const isSourceNotFoundLoadable = (loadable: Loadable<unknown>): boolean =>
  loadable.status === "error" &&
  loadable.error.message.toLowerCase().includes("source not found");

type SourceFormBase = {
  name: string;
  kind: Source["kind"];
  endpoint: string;
  namespace: string;
  enabled: boolean;
  specUrl: string;
  service: string;
  version: string;
  defaultHeadersText: string;
  authKind: Source["auth"]["kind"];
  authHeaderName: string;
  authPrefix: string;
  bearerProviderId: string;
  bearerHandle: string;
  oauthAccessProviderId: string;
  oauthAccessHandle: string;
  oauthRefreshProviderId: string;
  oauthRefreshHandle: string;
  oauthClientId: string;
  oauthClientSecret: string;
  oauthAuthorizationEndpoint: string;
  oauthTokenEndpoint: string;
  oauthScopesText: string;
  managedAuth: Extract<
    Source["auth"],
    { kind: "provider_grant_ref" | "mcp_oauth" | "oauth2_authorized_user" }
  > | null;
};

type SourceFormState = SourceFormBase & McpTransportFields;

const kindOptions: ReadonlyArray<Source["kind"]> = [
  "mcp",
  "openapi",
  "graphql",
  "google_discovery",
  "internal",
];

const transportOptions: ReadonlyArray<Exclude<McpTransportValue, "">> = [
  "auto",
  "streamable-http",
  "sse",
  "stdio",
];

const authOptions: ReadonlyArray<Source["auth"]["kind"]> = [
  "none",
  "bearer",
  "oauth2",
  "provider_grant_ref",
  "mcp_oauth",
];

const trimToNull = (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const namespaceFromUrl = (url: string): string => {
  try {
    const domain = getDomain(url);
    if (!domain) return "";
    const dot = domain.indexOf(".");
    return dot > 0 ? domain.slice(0, dot) : domain;
  } catch {
    return "";
  }
};

const googleDiscoveryNamespace = (service: string): string =>
  `google.${service
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "")}`;

const readStoredSourceOAuthPopupResult = (
  sessionId: string,
): SourceOAuthPopupMessage | null => {
  if (typeof window === "undefined") {
    return null;
  }

  const raw = window.localStorage.getItem(
    `${SOURCE_OAUTH_POPUP_RESULT_STORAGE_KEY_PREFIX}${sessionId}`,
  );
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as SourceOAuthPopupMessage;
  } catch {
    return null;
  }
};

const clearStoredSourceOAuthPopupResult = (sessionId: string): void => {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.removeItem(
    `${SOURCE_OAUTH_POPUP_RESULT_STORAGE_KEY_PREFIX}${sessionId}`,
  );
};

const startSourceOAuthPopup = async (input: {
  authorizationUrl: string;
  sessionId: string;
}): Promise<CompleteSourceOAuthResult["auth"]> => {
  if (typeof window === "undefined") {
    throw new Error("OAuth popup is only available in a browser context");
  }

  clearStoredSourceOAuthPopupResult(input.sessionId);

  const popup = window.open(
    input.authorizationUrl,
    "executor-source-oauth",
    "popup=yes,width=520,height=720",
  );

  if (!popup) {
    throw new Error("Popup blocked. Allow popups and try again.");
  }

  popup.focus();

  return await new Promise<CompleteSourceOAuthResult["auth"]>(
    (resolve, reject) => {
      let settled = false;
      let closedPoll = 0;
      let resultTimeout = 0;

      const cleanup = () => {
        window.removeEventListener("message", onMessage);
        if (closedPoll) {
          window.clearInterval(closedPoll);
        }
        if (resultTimeout) {
          window.clearTimeout(resultTimeout);
        }
        if (!popup.closed) {
          popup.close();
        }
        clearStoredSourceOAuthPopupResult(input.sessionId);
      };

      const settleWithError = (message: string) => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();
        reject(new Error(message));
      };

      const settleFromPayload = (data: OAuthPopupResultMessage) => {
        if (!data.ok) {
          settleWithError(data.error || "OAuth failed");
          return;
        }

        if (settled) {
          return;
        }

        settled = true;
        cleanup();
        resolve(data.auth);
      };

      const onMessage = (event: MessageEvent) => {
        if (event.origin !== window.location.origin) {
          return;
        }

        const data = event.data as SourceOAuthPopupMessage | undefined;
        if (!data || data.type !== "executor:oauth-result") {
          return;
        }

        if (data.ok && data.sessionId !== input.sessionId) {
          return;
        }

        if (
          !data.ok &&
          data.sessionId !== null &&
          data.sessionId !== input.sessionId
        ) {
          return;
        }

        settleFromPayload(data);
      };

      window.addEventListener("message", onMessage);

      resultTimeout = window.setTimeout(() => {
        settleWithError(
          "OAuth popup timed out before completion. Please try again.",
        );
      }, SOURCE_OAUTH_POPUP_RESULT_TIMEOUT_MS);

      closedPoll = window.setInterval(() => {
        const stored = readStoredSourceOAuthPopupResult(input.sessionId);
        if (stored?.type === "executor:oauth-result") {
          settleFromPayload(stored);
          return;
        }
        if (popup.closed) {
          // Stop polling — only run one final deferred check to give the
          // callback page time to write localStorage before we give up.
          window.clearInterval(closedPoll);
          closedPoll = 0;
          window.setTimeout(() => {
            const delayedStored = readStoredSourceOAuthPopupResult(
              input.sessionId,
            );
            if (delayedStored?.type === "executor:oauth-result") {
              settleFromPayload(delayedStored);
              return;
            }
            settleWithError("OAuth popup was closed before completion.");
          }, 1500);
        }
      }, 300);
    },
  );
};

const startConnectedSourceOAuthPopup = async (input: {
  authorizationUrl: string;
  sessionId: string;
}): Promise<void> => {
  if (typeof window === "undefined") {
    throw new Error("OAuth popup is only available in a browser context");
  }

  clearStoredSourceOAuthPopupResult(input.sessionId);

  const popup = window.open(
    input.authorizationUrl,
    "executor-source-oauth",
    "popup=yes,width=520,height=720",
  );

  if (!popup) {
    throw new Error("Popup blocked. Allow popups and try again.");
  }

  popup.focus();

  return await new Promise<void>((resolve, reject) => {
    let settled = false;
    let closedPoll = 0;
    let resultTimeout = 0;

    const cleanup = () => {
      window.removeEventListener("message", onMessage);
      if (closedPoll) {
        window.clearInterval(closedPoll);
      }
      if (resultTimeout) {
        window.clearTimeout(resultTimeout);
      }
      if (!popup.closed) {
        popup.close();
      }
      clearStoredSourceOAuthPopupResult(input.sessionId);
    };

    const settleWithError = (message: string) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(new Error(message));
    };

    const settleFromPayload = (data: SourceOAuthPopupMessage) => {
      if (!data.ok) {
        settleWithError(data.error || "OAuth failed");
        return;
      }

      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve();
    };

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) {
        return;
      }

      const data = event.data as SourceOAuthPopupMessage | undefined;
      if (!data) {
        return;
      }

      if (data.type === "executor:oauth-result") {
        if (data.ok && data.sessionId !== input.sessionId) {
          return;
        }
        if (
          !data.ok &&
          data.sessionId !== null &&
          data.sessionId !== input.sessionId
        ) {
          return;
        }
      } else if (data.type !== "executor:source-oauth-result") {
        return;
      }

      settleFromPayload(data);
    };

    window.addEventListener("message", onMessage);

    resultTimeout = window.setTimeout(() => {
      settleWithError(
        "OAuth popup timed out before completion. Please try again.",
      );
    }, SOURCE_OAUTH_POPUP_RESULT_TIMEOUT_MS);

    closedPoll = window.setInterval(() => {
      const stored = readStoredSourceOAuthPopupResult(input.sessionId);
      if (stored) {
        settleFromPayload(stored);
        return;
      }
      if (popup.closed) {
        window.clearInterval(closedPoll);
        closedPoll = 0;
        window.setTimeout(() => {
          const delayedStored = readStoredSourceOAuthPopupResult(
            input.sessionId,
          );
          if (delayedStored) {
            settleFromPayload(delayedStored);
            return;
          }
          settleWithError("OAuth popup was closed before completion.");
        }, 1500);
      }
    }, 300);
  });
};

const stringMapToEditor = (value: Record<string, string> | null): string =>
  value === null ? "" : JSON.stringify(value, null, 2);

const stringArrayToEditor = (
  value: ReadonlyArray<string> | null | undefined,
): string =>
  !value || value.length === 0 ? "" : JSON.stringify(value, null, 2);

const scopesTextFromArray = (
  value: ReadonlyArray<string> | null | undefined,
): string => (value && value.length > 0 ? value.join(" ") : "");

const parseScopesText = (value: string): Array<string> =>
  [...new Set(
    value
      .split(/[\s,]+/)
      .map((scope) => scope.trim())
      .filter((scope) => scope.length > 0),
  )];

const readBindingStringMap = (
  source: Source,
  key: string,
): Record<string, string> | null => {
  const candidate = source.binding[key];
  if (
    candidate === null ||
    candidate === undefined ||
    typeof candidate !== "object" ||
    Array.isArray(candidate)
  ) {
    return null;
  }

  const entries = Object.entries(candidate as Record<string, unknown>);
  return entries.every(([, value]) => typeof value === "string")
    ? Object.fromEntries(entries as ReadonlyArray<readonly [string, string]>)
    : null;
};

const readBindingStringArray = (
  source: Source,
  key: string,
): Array<string> | null => {
  const candidate = source.binding[key];
  return Array.isArray(candidate) &&
    candidate.every((value) => typeof value === "string")
    ? [...candidate]
    : null;
};

const readBindingString = (source: Source, key: string): string =>
  typeof source.binding[key] === "string" ? String(source.binding[key]) : "";

const readBindingOauth2Setup = (source: Source): {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  scopes: Array<string>;
  headerName: string | null;
  prefix: string | null;
  clientAuthentication: "none" | "client_secret_post" | null;
} | null => {
  const candidate = source.binding.oauth2;
  if (
    candidate === null ||
    candidate === undefined ||
    typeof candidate !== "object" ||
    Array.isArray(candidate)
  ) {
    return null;
  }

  const record = candidate as Record<string, unknown>;
  const authorizationEndpoint =
    typeof record.authorizationEndpoint === "string"
      ? record.authorizationEndpoint.trim()
      : "";
  const tokenEndpoint =
    typeof record.tokenEndpoint === "string"
      ? record.tokenEndpoint.trim()
      : "";
  if (!authorizationEndpoint || !tokenEndpoint) {
    return null;
  }

  return {
    authorizationEndpoint,
    tokenEndpoint,
    scopes: Array.isArray(record.scopes)
      ? record.scopes.filter((scope): scope is string => typeof scope === "string")
      : [],
    headerName:
      typeof record.headerName === "string" ? record.headerName : null,
    prefix: typeof record.prefix === "string" ? record.prefix : null,
    clientAuthentication:
      record.clientAuthentication === "none" ||
      record.clientAuthentication === "client_secret_post"
        ? record.clientAuthentication
        : null,
  };
};

const supportsManagedHttpOAuth = (
  kind: Source["kind"],
): kind is "openapi" | "graphql" =>
  kind === "openapi" || kind === "graphql";

const readBindingTransport = (source: Source): McpTransportValue => {
  const candidate = source.binding.transport;
  return typeof candidate === "string" &&
    (candidate === "auto" ||
      candidate === "streamable-http" ||
      candidate === "sse" ||
      candidate === "stdio")
    ? candidate
    : "";
};

const buildSyntheticMcpStdioEndpoint = (input: {
  name?: string | null;
  endpoint?: string | null;
  command?: string | null;
}): string => {
  const label =
    input.name?.trim() ||
    input.endpoint?.trim() ||
    input.command?.trim() ||
    "mcp";
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return `stdio://local/${slug || "mcp"}`;
};

const defaultFormState = (template?: SourceTemplate): SourceFormState => ({
  name: template?.name ?? "",
  kind: template?.kind ?? "openapi",
  endpoint: template?.endpoint ?? "",
  namespace: template
    ? (template.namespace ??
      ("service" in template
        ? googleDiscoveryNamespace(template.service)
        : namespaceFromUrl(template.endpoint ?? "")))
    : "",
  enabled: true,
  specUrl: template && "specUrl" in template ? template.specUrl : "",
  service: template && "service" in template ? template.service : "",
  version: template && "version" in template ? template.version : "",
  defaultHeadersText: "",
  authKind: template?.kind === "google_discovery" ? "oauth2" : "none",
  authHeaderName: "Authorization",
  authPrefix: "Bearer ",
  oauthClientId: "",
  oauthClientSecret: "",
  oauthAuthorizationEndpoint: "",
  oauthTokenEndpoint: "",
  oauthScopesText: "",
  bearerProviderId: "",
  bearerHandle: "",
  oauthAccessProviderId: "",
  oauthAccessHandle: "",
  oauthRefreshProviderId: "",
  oauthRefreshHandle: "",
  managedAuth: null,
  ...(template?.kind === "mcp" && template.connectionType === "command"
    ? defaultMcpStdioTransportFields({
        command: template.command ?? "",
        argsText: stringArrayToEditor(template.args),
        envText: stringMapToEditor(template.env ?? null),
        cwd: template.cwd ?? "",
      })
    : defaultMcpRemoteTransportFields(
        template?.kind === "mcp"
          ? asMcpRemoteTransportValue(template.transport)
          : "",
      )),
});

const formStateFromSource = (source: Source): SourceFormState => {
  const oauth2Setup = readBindingOauth2Setup(source);

  return ({
  name: source.name,
  kind: source.kind,
  endpoint: source.endpoint,
  namespace: source.namespace ?? "",
  enabled: source.enabled,
  specUrl: readBindingString(source, "specUrl"),
  service: readBindingString(source, "service"),
  version: readBindingString(source, "version"),
  defaultHeadersText: stringMapToEditor(
    readBindingStringMap(source, "defaultHeaders"),
  ),
  authKind:
    source.auth.kind === "oauth2_authorized_user" ||
    (source.auth.kind === "none" && oauth2Setup !== null)
      ? "oauth2"
      : source.auth.kind,
  authHeaderName:
    source.auth.kind === "oauth2_authorized_user"
      ? source.auth.headerName
      : source.auth.kind === "none" || source.auth.kind === "mcp_oauth"
        ? oauth2Setup?.headerName ?? "Authorization"
      : source.auth.headerName,
  authPrefix:
    source.auth.kind === "oauth2_authorized_user"
      ? source.auth.prefix
      : source.auth.kind === "none" || source.auth.kind === "mcp_oauth"
        ? oauth2Setup?.prefix ?? "Bearer "
      : source.auth.prefix,
  oauthClientId:
    source.auth.kind === "oauth2_authorized_user" ? source.auth.clientId : "",
  oauthClientSecret: "",
  oauthAuthorizationEndpoint: oauth2Setup?.authorizationEndpoint ?? "",
  oauthTokenEndpoint: oauth2Setup?.tokenEndpoint ?? "",
  oauthScopesText: scopesTextFromArray(oauth2Setup?.scopes),
  bearerProviderId:
    source.auth.kind === "bearer" ? source.auth.token.providerId : "",
  bearerHandle: source.auth.kind === "bearer" ? source.auth.token.handle : "",
  oauthAccessProviderId:
    source.auth.kind === "oauth2" ? source.auth.accessToken.providerId : "",
  oauthAccessHandle:
    source.auth.kind === "oauth2" ? source.auth.accessToken.handle : "",
  oauthRefreshProviderId:
    source.auth.kind === "oauth2" && source.auth.refreshToken !== null
      ? source.auth.refreshToken.providerId
      : "",
  oauthRefreshHandle:
    source.auth.kind === "oauth2" && source.auth.refreshToken !== null
      ? source.auth.refreshToken.handle
      : "",
  managedAuth:
    source.auth.kind === "oauth2_authorized_user" ||
    source.auth.kind === "provider_grant_ref" ||
    source.auth.kind === "mcp_oauth"
      ? source.auth
      : null,
  ...(source.kind === "mcp" && readBindingTransport(source) === "stdio"
    ? defaultMcpStdioTransportFields({
        command: readBindingString(source, "command"),
        argsText: stringArrayToEditor(readBindingStringArray(source, "args")),
        envText: stringMapToEditor(readBindingStringMap(source, "env")),
        cwd: readBindingString(source, "cwd"),
      })
    : defaultMcpRemoteTransportFields(
        source.kind === "mcp"
          ? asMcpRemoteTransportValue(readBindingTransport(source) || "auto")
          : "",
      )),
  ...(source.kind === "mcp" && readBindingTransport(source) !== "stdio"
    ? {
        queryParamsText: stringMapToEditor(
          readBindingStringMap(source, "queryParams"),
        ),
        headersText: stringMapToEditor(readBindingStringMap(source, "headers")),
      }
    : {}),
  });
};

const buildAuthPayload = (
  state: SourceFormState,
): CreateSourcePayload["auth"] => {
  if (state.authKind === "none") {
    return { kind: "none" };
  }

  if (
    (state.authKind === "provider_grant_ref" ||
      state.authKind === "mcp_oauth" ||
      (state.authKind === "oauth2" && state.managedAuth?.kind === "oauth2_authorized_user")) &&
    state.managedAuth !== null
  ) {
    return state.managedAuth;
  }

  const headerName = state.authHeaderName.trim() || "Authorization";
  const prefix = state.authPrefix;

  if (state.authKind === "bearer") {
    const providerId = state.bearerProviderId.trim();
    const handle = state.bearerHandle.trim();
    if (!providerId || !handle) {
      throw new Error(
        "Bearer auth requires a token. Select or create a secret.",
      );
    }

    return {
      kind: "bearer",
      headerName,
      prefix,
      token: {
        providerId,
        handle,
      },
    };
  }

  const accessProviderId = state.oauthAccessProviderId.trim();
  const accessHandle = state.oauthAccessHandle.trim();
  if (
    supportsManagedHttpOAuth(state.kind) &&
    (state.oauthAuthorizationEndpoint.trim().length > 0 ||
      state.oauthTokenEndpoint.trim().length > 0) &&
    !accessProviderId &&
    !accessHandle
  ) {
    return { kind: "none" };
  }
  if (!accessProviderId || !accessHandle) {
    throw new Error(
      "OAuth2 auth requires an access token. Select a secret or use OAuth sign-in.",
    );
  }

  const refreshProviderId = trimToNull(state.oauthRefreshProviderId);
  const refreshHandle = trimToNull(state.oauthRefreshHandle);
  if ((refreshProviderId === null) !== (refreshHandle === null)) {
    throw new Error(
      "OAuth2 refresh token provider ID and handle must be set together.",
    );
  }

  return {
    kind: "oauth2",
    headerName,
    prefix,
    accessToken: {
      providerId: accessProviderId,
      handle: accessHandle,
    },
    refreshToken:
      refreshProviderId === null || refreshHandle === null
        ? null
        : {
            providerId: refreshProviderId,
            handle: refreshHandle,
          },
  };
};

const buildHttpOauth2Binding = (
  state: SourceFormState,
): {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  scopes: ReadonlyArray<string>;
  headerName?: string | null;
  prefix?: string | null;
  clientAuthentication: "none" | "client_secret_post";
  authorizationParams: null;
} | null => {
  if (!supportsManagedHttpOAuth(state.kind) || state.authKind !== "oauth2") {
    return null;
  }

  const authorizationEndpoint = trimToNull(state.oauthAuthorizationEndpoint);
  const tokenEndpoint = trimToNull(state.oauthTokenEndpoint);
  if (authorizationEndpoint === null || tokenEndpoint === null) {
    return null;
  }

  return {
    authorizationEndpoint,
    tokenEndpoint,
    scopes: parseScopesText(state.oauthScopesText),
    headerName: trimToNull(state.authHeaderName),
    prefix: state.authPrefix.length === 0 ? null : state.authPrefix,
    clientAuthentication: trimToNull(state.oauthClientSecret)
      ? "client_secret_post"
      : "none",
    authorizationParams: null,
  };
};

const buildOauthClientInput = (
  state: SourceFormState,
): { clientId: string; clientSecret: string | null; redirectMode: "app_callback" } | null => {
  const clientId = trimToNull(state.oauthClientId);
  if (clientId === null) {
    return null;
  }

  return {
    clientId,
    clientSecret: trimToNull(state.oauthClientSecret),
    redirectMode: "app_callback",
  };
};

const buildRequestedSourceStatus = (
  state: SourceFormState,
): CreateSourcePayload["status"] => {
  if (
    state.kind !== "mcp" &&
    state.kind !== "openapi" &&
    state.kind !== "graphql"
  ) {
    return undefined;
  }

  return state.enabled ? "connected" : "draft";
};

const buildSourcePayload = (state: SourceFormState): CreateSourcePayload => {
  const name = state.name.trim();
  const isMcpStdio = state.kind === "mcp" && state.transport === "stdio";
  const endpoint =
    state.kind === "mcp" && state.transport === "stdio"
      ? buildSyntheticMcpStdioEndpoint({
          name: state.name,
          endpoint: state.endpoint,
          command: state.command,
        })
      : state.endpoint.trim();

  if (!name) {
    throw new Error("Source name is required.");
  }

  if (!endpoint) {
    throw new Error("Source endpoint is required.");
  }
  if (isMcpStdio && !state.command.trim()) {
    throw new Error("MCP stdio transport requires a command.");
  }

  const shared = {
    name,
    kind: state.kind,
    endpoint,
    status: buildRequestedSourceStatus(state),
    enabled: state.enabled,
    namespace: trimToNull(state.namespace),
    auth: isMcpStdio ? { kind: "none" as const } : buildAuthPayload(state),
  } satisfies Pick<
    CreateSourcePayload,
    "name" | "kind" | "endpoint" | "status" | "enabled" | "namespace" | "auth"
  >;

  if (state.kind === "mcp") {
    if (state.transport === "stdio") {
      return {
        ...shared,
        binding: {
          transport: "stdio",
          queryParams: null,
          headers: null,
          command: state.command.trim(),
          args: parseJsonStringArray("Args", state.argsText),
          env: parseJsonStringMap("Environment", state.envText),
          cwd: trimToNull(state.cwd),
        },
      };
    }

    return {
      ...shared,
      binding: {
        transport: state.transport === "" ? "auto" : state.transport,
        queryParams: parseJsonStringMap("Query params", state.queryParamsText),
        headers: parseJsonStringMap("Request headers", state.headersText),
        command: null,
        args: null,
        env: null,
        cwd: null,
      },
    };
  }

  if (state.kind === "openapi") {
    const specUrl = state.specUrl.trim();
    if (!specUrl) {
      throw new Error("OpenAPI sources require a spec URL.");
    }

    return {
      ...shared,
      binding: {
        specUrl,
        defaultHeaders: parseJsonStringMap(
          "Default headers",
          state.defaultHeadersText,
        ),
        oauth2: buildHttpOauth2Binding(state),
      },
    };
  }

  if (state.kind === "graphql") {
    return {
      ...shared,
      binding: {
        defaultHeaders: parseJsonStringMap(
          "Default headers",
          state.defaultHeadersText,
        ),
        oauth2: buildHttpOauth2Binding(state),
      },
    };
  }

  if (state.kind === "google_discovery") {
    const service = state.service.trim();
    const version = state.version.trim();
    if (!service) {
      throw new Error("Google Discovery sources require a service.");
    }
    if (!version) {
      throw new Error("Google Discovery sources require a version.");
    }

    return {
      ...shared,
      binding: {
        service,
        version,
        discoveryUrl: endpoint,
        defaultHeaders: parseJsonStringMap(
          "Default headers",
          state.defaultHeadersText,
        ),
      },
    };
  }

  return {
    ...shared,
    binding: {},
  };
};

const buildUpdatePayload = (state: SourceFormState): UpdateSourcePayload => {
  const sourcePayload = buildSourcePayload(state);

  return {
    name: sourcePayload.name,
    endpoint: sourcePayload.endpoint,
    status: sourcePayload.status,
    enabled: sourcePayload.enabled,
    namespace: sourcePayload.namespace,
    binding: sourcePayload.binding,
    importAuthPolicy: sourcePayload.importAuthPolicy,
    importAuth: sourcePayload.importAuth,
    auth: sourcePayload.auth,
    sourceHash: sourcePayload.sourceHash,
    lastError: sourcePayload.lastError,
  };
};

const buildStartSourceOAuthPayload = (
  state: SourceFormState,
): StartSourceOAuthPayload => {
  if (state.kind !== "mcp") {
    throw new Error("OAuth sign-in is only available for MCP sources.");
  }
  if (state.transport === "stdio") {
    throw new Error("OAuth sign-in is not available for MCP stdio sources.");
  }

  const endpoint = state.endpoint.trim();
  if (!endpoint) {
    throw new Error("Source endpoint is required before starting OAuth.");
  }

  return {
    provider: "mcp",
    name: trimToNull(state.name),
    endpoint,
    transport: state.transport === "" ? "auto" : state.transport,
    queryParams: parseJsonStringMap("Query params", state.queryParamsText),
    headers: parseJsonStringMap("Request headers", state.headersText),
  };
};

const buildHttpOauthConnectPayload = (
  state: SourceFormState,
): ConnectSourcePayload => {
  if (!supportsManagedHttpOAuth(state.kind)) {
    throw new Error("OAuth sign-in is only available for HTTP sources.");
  }

  const endpoint = state.endpoint.trim();
  if (!endpoint) {
    throw new Error("Source endpoint is required before starting OAuth.");
  }

  const oauthClient = buildOauthClientInput(state);
  const oauth2Setup = buildHttpOauth2Binding(state);
  if (oauthClient === null && oauth2Setup !== null) {
    throw new Error("OAuth sign-in requires a client ID.");
  }
  if (oauth2Setup === null) {
    throw new Error(
      "OAuth sign-in requires authorization and token endpoints.",
    );
  }

  if (state.kind === "openapi") {
    const specUrl = state.specUrl.trim();
    if (!specUrl) {
      throw new Error("OpenAPI sources require a spec URL.");
    }

    return {
      kind: "openapi",
      endpoint,
      specUrl,
      name: trimToNull(state.name),
      namespace: trimToNull(state.namespace),
      oauthClient,
      oauth2Setup,
      auth: undefined,
    };
  }

  return {
    kind: "graphql",
    endpoint,
    name: trimToNull(state.name),
    namespace: trimToNull(state.namespace),
    oauthClient,
    oauth2Setup,
    auth: undefined,
  };
};

export function NewSourcePage() {
  return <SourceEditor key="create" mode="create" />;
}

export function EditSourcePage(props: { sourceId: string }) {
  const sources = useSources();
  const source = useSource(props.sourceId);
  const missingSource =
    (sources.status === "ready" &&
      !sources.data.some((candidate) => candidate.id === props.sourceId)) ||
    isSourceNotFoundLoadable(source);

  if (missingSource) {
    return <SourceNotFoundState />;
  }

  return (
    <LoadableBlock loadable={source} loading="Loading source...">
      {(loadedSource) => (
        <SourceEditor
          key={`${loadedSource.id}:${loadedSource.updatedAt}`}
          mode="edit"
          source={loadedSource}
        />
      )}
    </LoadableBlock>
  );
}

function SourceEditor(props: { mode: "create" | "edit"; source?: Source }) {
  const navigate = useNavigate();
  const createSource = useCreateSource();
  const connectSource = useConnectSource();
  const invalidateExecutorQueries = useInvalidateExecutorQueries();
  const startSourceOAuth = useStartSourceOAuth();
  const updateSource = useUpdateSource();
  const removeSource = useRemoveSource();
  const removeProviderAuthGrant = useRemoveProviderAuthGrant();
  const instanceConfig = useInstanceConfig();
  const secrets = useSecrets();
  const refreshSecrets = useRefreshSecrets();
  const [formState, setFormState] = useState<SourceFormState>(() =>
    props.source ? formStateFromSource(props.source) : defaultFormState(),
  );
  const [statusBanner, setStatusBanner] = useState<StatusBannerState | null>(
    null,
  );
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(
    null,
  );
  const [oauthPopupBusy, setOauthPopupBusy] = useState(false);
  const [expandedOauthSecretRefTarget, setExpandedOauthSecretRefTarget] =
    useState<string | null>(null);

  const isSubmitting =
    createSource.status === "pending" || updateSource.status === "pending";
  const isDeleting = removeSource.status === "pending";
  const isRevokingGrant = removeProviderAuthGrant.status === "pending";
  const isOAuthSubmitting =
    startSourceOAuth.status === "pending" ||
    connectSource.status === "pending" ||
    oauthPopupBusy;
  const oauthSecretRefTarget =
    formState.authKind === "oauth2" &&
    formState.oauthAccessHandle.trim().length > 0
      ? `${formState.oauthAccessProviderId}:${formState.oauthAccessHandle}:${formState.oauthRefreshProviderId}:${formState.oauthRefreshHandle}`
      : null;
  const showOauthSecretRefs =
    oauthSecretRefTarget !== null &&
    expandedOauthSecretRefTarget === oauthSecretRefTarget;

  const setField = <K extends keyof SourceFormBase>(
    key: K,
    value: SourceFormBase[K],
  ) => {
    setFormState((current) => ({ ...current, [key]: value }));
  };

  const setTransport = (transport: McpTransportValue) => {
    setFormState((current) => ({
      ...current,
      ...setMcpTransportFieldsTransport(current, transport),
    }));
  };

  const setRemoteTransportField = <
    K extends Exclude<keyof McpRemoteTransportFields, "transport">,
  >(
    key: K,
    value: McpRemoteTransportFields[K],
  ) => {
    setFormState((current) =>
      current.transport === "stdio" ? current : { ...current, [key]: value },
    );
  };

  const setStdioTransportField = <
    K extends Exclude<keyof McpStdioTransportFields, "transport">,
  >(
    key: K,
    value: McpStdioTransportFields[K],
  ) => {
    setFormState((current) =>
      current.transport === "stdio" ? { ...current, [key]: value } : current,
    );
  };

  const applyTemplate = (template: SourceTemplate) => {
    setSelectedTemplateId(template.id);
    setFormState((current) => ({
      ...defaultFormState(template),
      name: current.name.trim().length > 0 ? current.name : template.name,
      enabled: current.enabled,
    }));
    setStatusBanner({
      tone: "info",
      text: `${template.name} loaded. Add auth if needed, then save.`,
    });
  };

  const handleSubmit = async () => {
    setStatusBanner(null);

    try {
      if (props.mode === "create") {
        const createdSource = await createSource.mutateAsync(
          buildSourcePayload(formState),
        );
        void navigate({
          to: "/sources/$sourceId",
          params: { sourceId: createdSource.id },
          search: { tab: "model" },
        });
        return;
      }

      if (!props.source) {
        throw new Error("Cannot update a source before it has loaded.");
      }

      const updatedSource = await updateSource.mutateAsync({
        sourceId: props.source.id,
        payload: buildUpdatePayload(formState),
      });
      void navigate({
        to: "/sources/$sourceId",
        params: { sourceId: updatedSource.id },
        search: { tab: "model" },
      });
    } catch (error) {
      setStatusBanner({
        tone: "error",
        text: error instanceof Error ? error.message : "Failed saving source.",
      });
    }
  };

  const handleMcpOAuthConnect = async () => {
    setStatusBanner(null);

    try {
      const result = await startSourceOAuth.mutateAsync(
        buildStartSourceOAuthPayload(formState),
      );

      setStatusBanner({
        tone: "info",
        text: "Finish OAuth in the popup. Saving will create the source and connect its tools.",
      });

      setOauthPopupBusy(true);
      const auth = await startSourceOAuthPopup({
        authorizationUrl: result.authorizationUrl,
        sessionId: result.sessionId,
      });
      setOauthPopupBusy(false);
      refreshSecrets();
      setExpandedOauthSecretRefTarget(null);
      setFormState((current) => ({
        ...current,
        authKind: "oauth2",
        authHeaderName: auth.headerName,
        authPrefix: auth.prefix,
        oauthAccessProviderId: auth.accessToken.providerId,
        oauthAccessHandle: auth.accessToken.handle,
        oauthRefreshProviderId: auth.refreshToken?.providerId ?? "",
        oauthRefreshHandle: auth.refreshToken?.handle ?? "",
        managedAuth: null,
      }));
      setStatusBanner({
        tone: "success",
        text: "OAuth credentials are ready. Save the source to connect and index tools.",
      });
    } catch (error) {
      setOauthPopupBusy(false);
      setStatusBanner({
        tone: "error",
        text: error instanceof Error ? error.message : "Failed starting OAuth.",
      });
    }
  };

  const handleHttpOAuthConnect = async () => {
    setStatusBanner(null);

    try {
      if (props.mode === "edit" && props.source) {
        await updateSource.mutateAsync({
          sourceId: props.source.id,
          payload: buildUpdatePayload(formState),
        });
      }

      const result = await connectSource.mutateAsync(
        buildHttpOauthConnectPayload(formState),
      );

      if (result.kind === "connected") {
        invalidateExecutorQueries();
        void navigate({
          to: "/sources/$sourceId",
          params: { sourceId: result.source.id },
          search: { tab: "model" },
        });
        return;
      }

      if (result.kind === "credential_required") {
        setStatusBanner({
          tone: "error",
          text:
            "OAuth setup was saved, but the source still requires credentials. Check the endpoints and client settings, then try again.",
        });
        return;
      }

      setStatusBanner({
        tone: "info",
        text: "Finish OAuth in the popup to connect this source.",
      });

      setOauthPopupBusy(true);
      await startConnectedSourceOAuthPopup({
        authorizationUrl: result.authorizationUrl,
        sessionId: result.sessionId,
      });
      setOauthPopupBusy(false);
      refreshSecrets();
      invalidateExecutorQueries();
      setStatusBanner({
        tone: "success",
        text: "OAuth completed. The source is now connected.",
      });
      void navigate({
        to: "/sources/$sourceId",
        params: { sourceId: result.source.id },
        search: { tab: "model" },
      });
    } catch (error) {
      setOauthPopupBusy(false);
      setStatusBanner({
        tone: "error",
        text: error instanceof Error ? error.message : "Failed starting OAuth.",
      });
    }
  };

  const handleRemove = async () => {
    if (!props.source || isDeleting) {
      return;
    }

    const confirmed = window.confirm(
      `Remove "${props.source.name}" and its indexed tools?`,
    );
    if (!confirmed) {
      return;
    }

    setStatusBanner(null);

    try {
      const result = await removeSource.mutateAsync(props.source.id);
      if (!result.removed) {
        throw new Error("Source was not removed.");
      }
      void navigate({ to: "/" });
    } catch (error) {
      setStatusBanner({
        tone: "error",
        text:
          error instanceof Error ? error.message : "Failed removing source.",
      });
    }
  };

  const handleRevokeProviderGrant = async () => {
    if (
      !props.source ||
      isRevokingGrant ||
      formState.managedAuth?.kind !== "provider_grant_ref"
    ) {
      return;
    }

    const confirmed = window.confirm(
      `Revoke the shared Google auth for "${props.source.name}"? This disconnects every source using the same shared grant.`,
    );
    if (!confirmed) {
      return;
    }

    setStatusBanner(null);

    try {
      const result = await removeProviderAuthGrant.mutateAsync(
        formState.managedAuth.grantId,
      );
      if (!result.removed) {
        throw new Error("Shared provider grant was not removed.");
      }

      setStatusBanner({
        tone: "success",
        text: "Shared provider grant revoked. Linked sources now require authentication again.",
      });
    } catch (error) {
      setStatusBanner({
        tone: "error",
        text:
          error instanceof Error
            ? error.message
            : "Failed revoking shared provider grant.",
      });
    }
  };

  const backLink =
    props.mode === "edit" && props.source
      ? {
          to: "/sources/$sourceId" as const,
          params: { sourceId: props.source.id },
          search: { tab: "model" as const },
        }
      : { to: "/" as const };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-8 lg:px-10 lg:py-12">
        {/* Back + title */}
        <Link
          {...backLink}
          className="inline-flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground mb-6"
        >
          <IconArrowLeft className="size-3.5" />
          {props.mode === "edit" ? "Back to source" : "Back"}
        </Link>

        <div className="flex items-center justify-between gap-4 mb-6">
          <h1 className="font-display text-2xl tracking-tight text-foreground lg:text-3xl">
            {props.mode === "edit" ? "Edit source" : "New source"}
          </h1>
          <div className="flex items-center gap-2">
            <Badge variant="outline">{formState.kind}</Badge>
            <Badge variant={formState.enabled ? "default" : "muted"}>
              {formState.enabled ? "enabled" : "disabled"}
            </Badge>
          </div>
        </div>

        {statusBanner && <StatusBanner state={statusBanner} className="mb-6" />}

        {/* Templates (create mode) */}
        {props.mode === "create" && (
          <Section title="Templates" className="mb-6">
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {sourceTemplates.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  onClick={() => applyTemplate(template)}
                  className={cn(
                    "rounded-xl border px-4 py-3 text-left transition-colors",
                    selectedTemplateId === template.id
                      ? "border-primary/40 bg-primary/8"
                      : "border-border bg-card/70 hover:bg-accent/50",
                  )}
                >
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <div className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
                        <SourceFavicon
                          endpoint={template.endpoint}
                          kind={template.kind}
                          className="size-4"
                        />
                      </div>
                      <span className="truncate text-[13px] font-medium text-foreground">
                        {template.name}
                      </span>
                    </div>
                    <Badge variant="outline" className="text-[9px]">
                      {template.kind}
                    </Badge>
                  </div>
                  <span className="text-[11px] text-muted-foreground line-clamp-1">
                    {template.summary}
                  </span>
                </button>
              ))}
            </div>
          </Section>
        )}

        {/* Form */}
        <div className="space-y-6">
          <Section title="Basics">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name">
                <TextInput
                  value={formState.name}
                  onChange={(value) => setField("name", value)}
                  placeholder="GitHub REST"
                />
              </Field>
              <Field label="Kind">
                <SelectInput
                  value={formState.kind}
                  onChange={(value) =>
                    setField("kind", value as Source["kind"])
                  }
                  options={kindOptions.map((value) => ({
                    value,
                    label: value,
                  }))}
                />
              </Field>
              {!(
                formState.kind === "mcp" && formState.transport === "stdio"
              ) && (
                <Field label="Endpoint" className="sm:col-span-2">
                  <TextInput
                    value={formState.endpoint}
                    onChange={(value) => setField("endpoint", value)}
                    placeholder={
                      formState.kind === "openapi"
                        ? "https://api.github.com"
                        : formState.kind === "graphql"
                          ? "https://api.linear.app/graphql"
                          : formState.kind === "google_discovery"
                            ? "https://www.googleapis.com/discovery/v1/apis/sheets/v4/rest"
                            : "https://mcp.deepwiki.com/mcp"
                    }
                    mono
                  />
                </Field>
              )}
              <Field label="Namespace">
                <TextInput
                  value={formState.namespace}
                  onChange={(value) => setField("namespace", value)}
                  placeholder="github"
                />
              </Field>
              <Field label="Status">
                <ToggleButton
                  checked={formState.enabled}
                  onChange={(checked) => setField("enabled", checked)}
                />
              </Field>
            </div>
          </Section>

          {formState.kind === "mcp" && (
            <Section title="Transport">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Transport mode">
                  <SelectInput
                    value={formState.transport || "auto"}
                    onChange={(value) => setTransport(value as McpTransportValue)}
                    options={transportOptions.map((value) => ({
                      value,
                      label: value,
                    }))}
                  />
                </Field>
                {formState.transport === "stdio" ? (
                  <div className="sm:col-span-2 grid gap-4 sm:grid-cols-2">
                    <Field label="Command">
                      <TextInput
                        value={formState.command}
                        onChange={(value) =>
                          setStdioTransportField("command", value)
                        }
                        placeholder="npx"
                        mono
                      />
                    </Field>
                    <Field label="Working directory (optional)">
                      <TextInput
                        value={formState.cwd}
                        onChange={(value) =>
                          setStdioTransportField("cwd", value)
                        }
                        placeholder="/path/to/project"
                        mono
                      />
                    </Field>
                    <Field label="Args (JSON)" className="sm:col-span-2">
                      <CodeEditor
                        value={formState.argsText}
                        onChange={(value) =>
                          setStdioTransportField("argsText", value)
                        }
                        placeholder={
                          '[\n  "-y",\n  "chrome-devtools-mcp@latest"\n]'
                        }
                      />
                    </Field>
                    <Field label="Environment (JSON)" className="sm:col-span-2">
                      <CodeEditor
                        value={formState.envText}
                        onChange={(value) =>
                          setStdioTransportField("envText", value)
                        }
                        placeholder={
                          '{\n  "CHROME_PATH": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"\n}'
                        }
                      />
                    </Field>
                  </div>
                ) : (
                  <div className="sm:col-span-2 grid gap-4 sm:grid-cols-2">
                    <Field label="Query params (JSON)">
                      <CodeEditor
                        value={formState.queryParamsText}
                        onChange={(value) =>
                          setRemoteTransportField("queryParamsText", value)
                        }
                        placeholder={'{\n  "workspace": "demo"\n}'}
                      />
                    </Field>
                    <Field label="Headers (JSON)">
                      <CodeEditor
                        value={formState.headersText}
                        onChange={(value) =>
                          setRemoteTransportField("headersText", value)
                        }
                        placeholder={'{\n  "x-api-key": "..."\n}'}
                      />
                    </Field>
                  </div>
                )}
              </div>
            </Section>
          )}

          {formState.kind === "openapi" && (
            <Section title="OpenAPI">
              <div className="grid gap-4">
                <Field label="Spec URL">
                  <TextInput
                    value={formState.specUrl}
                    onChange={(value) => setField("specUrl", value)}
                    placeholder="https://raw.githubusercontent.com/.../openapi.yaml"
                    mono
                  />
                </Field>
                <Field label="Default headers (JSON)">
                  <CodeEditor
                    value={formState.defaultHeadersText}
                    onChange={(value) => setField("defaultHeadersText", value)}
                    placeholder={'{\n  "x-api-version": "2026-03-01"\n}'}
                  />
                </Field>
              </div>
            </Section>
          )}

          {formState.kind === "graphql" && (
            <Section title="GraphQL">
              <div className="grid gap-4">
                <Field label="Default headers (JSON)">
                  <CodeEditor
                    value={formState.defaultHeadersText}
                    onChange={(value) => setField("defaultHeadersText", value)}
                    placeholder={'{\n  "x-api-version": "2026-03-01"\n}'}
                  />
                </Field>
              </div>
            </Section>
          )}

          {formState.kind === "google_discovery" && (
            <Section title="Google Discovery">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Service">
                  <TextInput
                    value={formState.service}
                    onChange={(value) => setField("service", value)}
                    placeholder="sheets"
                  />
                </Field>
                <Field label="Version">
                  <TextInput
                    value={formState.version}
                    onChange={(value) => setField("version", value)}
                    placeholder="v4"
                  />
                </Field>
                <Field label="Default headers (JSON)" className="sm:col-span-2">
                  <CodeEditor
                    value={formState.defaultHeadersText}
                    onChange={(value) => setField("defaultHeadersText", value)}
                    placeholder={'{\n  "x-goog-user-project": "my-project"\n}'}
                  />
                </Field>
              </div>
            </Section>
          )}

          <Section title="Authentication">
            <div className="grid gap-4 sm:grid-cols-2">
              {formState.kind === "mcp" && formState.transport !== "stdio" && (
                <div className="sm:col-span-2 rounded-xl border border-border bg-gradient-to-b from-card/90 to-card/50 overflow-hidden">
                  <div className="flex items-start gap-3 px-4 py-3.5">
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/8 text-primary mt-0.5">
                      <svg
                        className="size-4"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <rect
                          x="3"
                          y="11"
                          width="18"
                          height="11"
                          rx="2"
                          ry="2"
                        />
                        <path d="M7 11V7a5 5 0 0110 0v4" />
                      </svg>
                    </div>
                    <div className="flex-1 min-w-0 space-y-2">
                      <div className="space-y-0.5">
                        <p className="text-[12px] font-medium text-foreground">
                          MCP OAuth
                        </p>
                        <p className="text-[11px] text-muted-foreground">
                          Opens the server's built-in OAuth flow to authenticate
                          this source.
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={handleMcpOAuthConnect}
                        disabled={
                          isSubmitting || isDeleting || isOAuthSubmitting
                        }
                      >
                        {isOAuthSubmitting ? (
                          <IconSpinner className="size-3" />
                        ) : null}
                        {formState.authKind === "oauth2" &&
                        formState.oauthAccessHandle.trim().length > 0
                          ? "Reconnect"
                          : "Sign in with OAuth"}
                      </Button>
                    </div>
                  </div>
                  {formState.authKind === "oauth2" &&
                    formState.oauthAccessHandle.trim().length > 0 && (
                      <div className="flex items-center justify-between gap-3 border-t border-border/50 px-4 py-2.5">
                        <p className="text-[11px] text-muted-foreground/70">
                          Token refs attached to this draft
                        </p>
                        <button
                          type="button"
                          className="text-[11px] font-medium text-muted-foreground/60 transition-colors hover:text-foreground"
                          onClick={() =>
                            setExpandedOauthSecretRefTarget((current) =>
                              current === oauthSecretRefTarget
                                ? null
                                : oauthSecretRefTarget,
                            )
                          }
                        >
                          {showOauthSecretRefs ? "Hide refs" : "Show refs"}
                        </button>
                      </div>
                    )}
                </div>
              )}
              {supportsManagedHttpOAuth(formState.kind) &&
                formState.authKind === "oauth2" &&
                formState.managedAuth?.kind !== "provider_grant_ref" && (
                  <div className="sm:col-span-2 rounded-xl border border-border bg-gradient-to-b from-card/90 to-card/50 overflow-hidden">
                    <div className="flex items-start gap-3 px-4 py-3.5">
                      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/8 text-primary mt-0.5">
                        <svg
                          className="size-4"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <rect
                            x="3"
                            y="11"
                            width="18"
                            height="11"
                            rx="2"
                            ry="2"
                          />
                          <path d="M7 11V7a5 5 0 0110 0v4" />
                        </svg>
                      </div>
                      <div className="flex-1 min-w-0 space-y-2">
                        <div className="space-y-0.5">
                          <p className="text-[12px] font-medium text-foreground">
                            Source OAuth2
                          </p>
                          <p className="text-[11px] text-muted-foreground">
                            Save the provider endpoints below, then sign in to
                            let executor complete the PKCE flow for this
                            source.
                          </p>
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={handleHttpOAuthConnect}
                          disabled={
                            isSubmitting || isDeleting || isOAuthSubmitting
                          }
                        >
                          {isOAuthSubmitting ? (
                            <IconSpinner className="size-3" />
                          ) : null}
                          {formState.managedAuth?.kind ===
                          "oauth2_authorized_user"
                            ? "Reconnect with OAuth"
                            : "Sign in with OAuth"}
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              {formState.kind === "mcp" && formState.transport === "stdio" ? (
                <div className="sm:col-span-2 rounded-xl border border-border bg-muted/40 px-4 py-3 text-[12px] text-muted-foreground">
                  Local MCP stdio sources do not use executor-managed HTTP or
                  OAuth credentials.
                </div>
              ) : (
                <Field label="Auth mode">
                  <SelectInput
                    value={formState.authKind}
                    onChange={(value) =>
                      setField("authKind", value as Source["auth"]["kind"])
                    }
                    disabled={formState.managedAuth !== null}
                    options={authOptions.map((value) => ({
                      value,
                      label: value,
                    }))}
                  />
                </Field>
              )}
              {formState.managedAuth !== null &&
                !(
                  formState.kind === "mcp" && formState.transport === "stdio"
                ) && (
                  <div className="sm:col-span-2 rounded-xl border border-border bg-gradient-to-b from-muted/40 to-transparent overflow-hidden">
                    <div className="flex items-start gap-3 px-4 py-3.5">
                      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/8 text-primary mt-0.5">
                        {formState.managedAuth.kind === "provider_grant_ref" ? (
                          <svg
                            className="size-4"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" />
                            <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />
                          </svg>
                        ) : (
                          <svg
                            className="size-4"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <rect
                              x="3"
                              y="11"
                              width="18"
                              height="11"
                              rx="2"
                              ry="2"
                            />
                            <path d="M7 11V7a5 5 0 0110 0v4" />
                          </svg>
                        )}
                      </div>
                      <div className="flex-1 min-w-0 space-y-1">
                        <p className="text-[12px] font-medium text-foreground">
                          {formState.managedAuth.kind === "provider_grant_ref"
                            ? "Shared provider grant"
                            : formState.managedAuth.kind ===
                                  "oauth2_authorized_user"
                              ? "Managed OAuth2 session"
                              : "Managed MCP OAuth"}
                        </p>
                        <p className="text-[11px] leading-relaxed text-muted-foreground">
                          {formState.managedAuth.kind === "provider_grant_ref"
                            ? "This source uses a shared Google auth grant. Reconnect from Add Source to change the linked account or scopes."
                            : formState.managedAuth.kind ===
                                  "oauth2_authorized_user"
                              ? "Executor is managing this OAuth2 session with a stored refresh token. Reconnect to replace the authorization."
                              : "Authenticated through a persisted MCP OAuth session. Reconnect the source to refresh or replace the binding."}
                        </p>
                      </div>
                    </div>
                    {formState.managedAuth.kind === "provider_grant_ref" &&
                      props.mode === "edit" && (
                        <div className="flex items-center justify-end border-t border-border/50 px-4 py-2.5">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="text-destructive/70 hover:text-destructive hover:bg-destructive/8"
                            onClick={handleRevokeProviderGrant}
                            disabled={isRevokingGrant}
                          >
                            <IconTrash className="size-3" />
                            {isRevokingGrant
                              ? "Revoking\u2026"
                              : "Revoke shared auth"}
                          </Button>
                        </div>
                      )}
                  </div>
                )}
              {formState.authKind !== "none" &&
                formState.managedAuth === null &&
                !(
                  formState.kind === "mcp" && formState.transport === "stdio"
                ) && (
                  <>
                    <Field label="Header name">
                      <TextInput
                        value={formState.authHeaderName}
                        onChange={(value) => setField("authHeaderName", value)}
                        placeholder="Authorization"
                      />
                    </Field>
                    <Field label="Prefix">
                      <TextInput
                        value={formState.authPrefix}
                        onChange={(value) => setField("authPrefix", value)}
                        placeholder="Bearer "
                      />
                    </Field>
                  </>
                )}

              {supportsManagedHttpOAuth(formState.kind) &&
                formState.authKind === "oauth2" &&
                formState.managedAuth?.kind !== "provider_grant_ref" && (
                  <>
                    <Field label="OAuth client ID" className="sm:col-span-2">
                      <TextInput
                        type="password"
                        value={formState.oauthClientId}
                        onChange={(value) => setField("oauthClientId", value)}
                        placeholder="client-id"
                      />
                    </Field>
                    <Field
                      label="OAuth client secret (optional)"
                      className="sm:col-span-2"
                    >
                      <TextInput
                        type="password"
                        value={formState.oauthClientSecret}
                        onChange={(value) =>
                          setField("oauthClientSecret", value)
                        }
                        placeholder="client-secret"
                      />
                    </Field>
                    <Field
                      label="Authorization endpoint"
                      className="sm:col-span-2"
                    >
                      <TextInput
                        value={formState.oauthAuthorizationEndpoint}
                        onChange={(value) =>
                          setField("oauthAuthorizationEndpoint", value)
                        }
                        placeholder="https://provider.example.com/oauth/authorize"
                        mono
                      />
                    </Field>
                    <Field label="Token endpoint" className="sm:col-span-2">
                      <TextInput
                        value={formState.oauthTokenEndpoint}
                        onChange={(value) =>
                          setField("oauthTokenEndpoint", value)
                        }
                        placeholder="https://provider.example.com/oauth/token"
                        mono
                      />
                    </Field>
                    <Field label="Scopes" className="sm:col-span-2">
                      <TextInput
                        value={formState.oauthScopesText}
                        onChange={(value) =>
                          setField("oauthScopesText", value)
                        }
                        placeholder="scope.one scope.two"
                      />
                    </Field>
                  </>
                )}

              {formState.authKind === "bearer" &&
                formState.managedAuth === null &&
                !(
                  formState.kind === "mcp" && formState.transport === "stdio"
                ) && (
                  <Field label="Token" className="sm:col-span-2">
                    <SecretPicker
                      instanceConfig={instanceConfig}
                      secrets={secrets}
                      providerId={formState.bearerProviderId}
                      handle={formState.bearerHandle}
                      onSelect={(providerId, handle) => {
                        setField("bearerProviderId", providerId);
                        setField("bearerHandle", handle);
                      }}
                    />
                  </Field>
                )}

              {formState.authKind === "oauth2" &&
                formState.managedAuth === null &&
                !(
                  formState.kind === "mcp" && formState.transport === "stdio"
                ) &&
                ((supportsManagedHttpOAuth(formState.kind)
                  ? buildHttpOauth2Binding(formState) === null ||
                    formState.oauthAccessHandle.trim().length > 0
                  : true) &&
                  (formState.kind !== "mcp" ||
                    formState.oauthAccessHandle.trim().length === 0 ||
                    showOauthSecretRefs)) && (
                  <>
                    <Field label="Access token" className="sm:col-span-2">
                      <SecretPicker
                        instanceConfig={instanceConfig}
                        secrets={secrets}
                        providerId={formState.oauthAccessProviderId}
                        handle={formState.oauthAccessHandle}
                        onSelect={(providerId, handle) => {
                          setField("oauthAccessProviderId", providerId);
                          setField("oauthAccessHandle", handle);
                        }}
                      />
                    </Field>
                    <Field
                      label="Refresh token (optional)"
                      className="sm:col-span-2"
                    >
                      <SecretPicker
                        instanceConfig={instanceConfig}
                        secrets={secrets}
                        providerId={formState.oauthRefreshProviderId}
                        handle={formState.oauthRefreshHandle}
                        onSelect={(providerId, handle) => {
                          setField("oauthRefreshProviderId", providerId);
                          setField("oauthRefreshHandle", handle);
                        }}
                        allowEmpty
                      />
                    </Field>
                  </>
                )}
            </div>
          </Section>

          {/* Danger zone (edit mode) */}
          {props.mode === "edit" && props.source && (
            <Section title="Danger zone">
              <Button
                variant="outline"
                className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={handleRemove}
                disabled={isDeleting || isRevokingGrant}
              >
                <IconTrash className="size-3.5" />
                {isDeleting ? "Removing\u2026" : "Remove source"}
              </Button>
            </Section>
          )}

          {/* Actions */}
          <div className="flex items-center justify-end gap-3 border-t border-border pt-5">
            <Link {...backLink} className="inline-flex">
              <Button variant="ghost" type="button">
                Cancel
              </Button>
            </Link>
            <Button
              onClick={handleSubmit}
              disabled={isSubmitting || isRevokingGrant}
            >
              {props.mode === "edit" ? (
                <IconPencil className="size-3.5" />
              ) : (
                <IconPlus className="size-3.5" />
              )}
              {isSubmitting
                ? props.mode === "edit"
                  ? "Saving\u2026"
                  : "Creating\u2026"
                : props.mode === "edit"
                  ? "Save"
                  : "Create source"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Form building blocks
// ---------------------------------------------------------------------------

function Section(props: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "rounded-xl border border-border bg-card/80",
        props.className,
      )}
    >
      <div className="border-b border-border px-5 py-3">
        <h2 className="text-sm font-semibold text-foreground">{props.title}</h2>
      </div>
      <div className="p-5">{props.children}</div>
    </section>
  );
}

function Field(props: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={cn("block space-y-1.5", props.className)}>
      <span className="text-[12px] font-medium text-foreground">
        {props.label}
      </span>
      {props.children}
    </label>
  );
}

function TextInput(props: {
  type?: "text" | "password";
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <input
      type={props.type || "text"}
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
      placeholder={props.placeholder}
      className={cn(
        "h-9 w-full rounded-lg border border-input bg-background px-3 text-[13px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/35 focus:border-ring focus:ring-1 focus:ring-ring/25",
        props.mono && "font-mono text-[12px]",
      )}
    />
  );
}

function SelectInput(props: {
  value: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
  disabled?: boolean;
}) {
  return (
    <select
      value={props.value}
      disabled={props.disabled}
      onChange={(event) => props.onChange(event.target.value)}
      className="h-9 w-full rounded-lg border border-input bg-background px-3 text-[13px] text-foreground outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
    >
      {props.options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function CodeEditor(props: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <textarea
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
      placeholder={props.placeholder}
      spellCheck={false}
      className="min-h-28 w-full rounded-lg border border-input bg-background px-3 py-2.5 font-mono text-[12px] leading-relaxed text-foreground outline-none transition-colors placeholder:text-muted-foreground/35 focus:border-ring focus:ring-1 focus:ring-ring/25"
    />
  );
}

function ToggleButton(props: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => props.onChange(!props.checked)}
      className={cn(
        "flex h-9 w-full items-center justify-between rounded-lg border px-3 text-[13px] transition-colors",
        props.checked
          ? "border-primary/40 bg-primary/8 text-foreground"
          : "border-input bg-background text-muted-foreground hover:text-foreground",
      )}
    >
      <span>{props.checked ? "Enabled" : "Disabled"}</span>
      <span
        className={cn(
          "size-2 rounded-full",
          props.checked ? "bg-primary" : "bg-muted-foreground/30",
        )}
      />
    </button>
  );
}

function StatusBanner(props: { state: StatusBannerState; className?: string }) {
  return (
    <div
      className={cn(
        "rounded-lg border px-4 py-3 text-[13px]",
        props.state.tone === "success" &&
          "border-primary/30 bg-primary/8 text-foreground",
        props.state.tone === "info" &&
          "border-border bg-card text-muted-foreground",
        props.state.tone === "error" &&
          "border-destructive/30 bg-destructive/8 text-destructive",
        props.className,
      )}
    >
      {props.state.text}
    </div>
  );
}

const CREATE_NEW_VALUE = "__create_new__";

function SecretPicker(props: {
  instanceConfig: Loadable<InstanceConfig>;
  secrets: Loadable<ReadonlyArray<SecretListItem>>;
  providerId: string;
  handle: string;
  onSelect: (providerId: string, handle: string) => void;
  allowEmpty?: boolean;
}) {
  const { instanceConfig, secrets, providerId, handle, onSelect, allowEmpty } =
    props;
  const createSecret = useCreateSecret();
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newValue, setNewValue] = useState("");
  const [newProviderId, setNewProviderId] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const storableProviders =
    instanceConfig.status === "ready"
      ? instanceConfig.data.secretProviders.filter(
          (provider) => provider.canStore,
        )
      : [];

  useEffect(() => {
    if (newProviderId.length > 0) {
      return;
    }
    if (instanceConfig.status === "ready") {
      setNewProviderId(instanceConfig.data.defaultSecretStoreProvider);
    }
  }, [instanceConfig, newProviderId]);

  // Build the selected value key: if handle is set, use it (it's the secret ID)
  const selectedValue = handle || "";

  const handleSelectChange = (value: string) => {
    if (value === CREATE_NEW_VALUE) {
      setShowCreate(true);
      setNewName("");
      setNewValue("");
      setNewProviderId(
        instanceConfig.status === "ready"
          ? instanceConfig.data.defaultSecretStoreProvider
          : "",
      );
      setCreateError(null);
      return;
    }
    if (value === "") {
      onSelect("", "");
      return;
    }
    const matchedSecret =
      secrets.status === "ready"
        ? secrets.data.find((secret) => secret.id === value)
        : null;
    onSelect(matchedSecret?.providerId ?? "local", value);
  };

  const handleCreate = async () => {
    setCreateError(null);
    const trimmedName = newName.trim();
    if (!trimmedName) {
      setCreateError("Name is required.");
      return;
    }
    if (!newValue) {
      setCreateError("Value is required.");
      return;
    }

    try {
      const result = await createSecret.mutateAsync({
        name: trimmedName,
        value: newValue,
        ...(newProviderId ? { providerId: newProviderId } : {}),
      });
      onSelect(result.providerId, result.id);
      setShowCreate(false);
    } catch (err) {
      setCreateError(
        err instanceof Error ? err.message : "Failed creating secret.",
      );
    }
  };

  if (secrets.status !== "ready") {
    return (
      <select
        disabled
        className="h-9 w-full rounded-lg border border-input bg-background px-3 text-[13px] text-muted-foreground outline-none opacity-60"
      >
        <option>Loading…</option>
      </select>
    );
  }

  const items = secrets.data;

  // Check if the current handle matches a known secret
  const matchedSecret = items.find((s) => s.id === handle);
  const isExternalRef = handle && !matchedSecret && providerId !== "local";

  return (
    <div className="space-y-2">
      <select
        value={showCreate ? CREATE_NEW_VALUE : selectedValue}
        onChange={(e) => handleSelectChange(e.target.value)}
        className="h-9 w-full rounded-lg border border-input bg-background px-3 text-[13px] text-foreground outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
      >
        {allowEmpty && <option value="">None</option>}
        {!allowEmpty && !selectedValue && (
          <option value="">Select a secret…</option>
        )}
        {items.map((secret) => (
          <option key={secret.id} value={secret.id}>
            {secret.name || secret.id} ({secret.providerId})
          </option>
        ))}
        {isExternalRef && (
          <option value={handle}>
            {providerId}:{handle}
          </option>
        )}
        <option value={CREATE_NEW_VALUE}>+ Create new secret</option>
      </select>

      {showCreate && (
        <div className="rounded-lg border border-primary/20 bg-card/80 p-3 space-y-3">
          {createError && (
            <div className="rounded-md border border-destructive/30 bg-destructive/8 px-3 py-2 text-[12px] text-destructive">
              {createError}
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block space-y-1">
              <span className="text-[11px] font-medium text-muted-foreground">
                Name
              </span>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="GitHub PAT"
                className="h-8 w-full rounded-lg border border-input bg-background px-3 text-[12px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/35 focus:border-ring focus:ring-1 focus:ring-ring/25"
                autoFocus
              />
            </label>
            <label className="block space-y-1">
              <span className="text-[11px] font-medium text-muted-foreground">
                Value
              </span>
              <input
                type="password"
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
                placeholder="ghp_..."
                className="h-8 w-full rounded-lg border border-input bg-background px-3 font-mono text-[11px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/35 focus:border-ring focus:ring-1 focus:ring-ring/25"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-[11px] font-medium text-muted-foreground">
                Store in
              </span>
              <select
                value={newProviderId}
                onChange={(e) => setNewProviderId(e.target.value)}
                className="h-8 w-full rounded-lg border border-input bg-background px-3 text-[12px] text-foreground outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
              >
                {storableProviders.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowCreate(false)}
              className="rounded-md px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              Cancel
            </button>
            <Button
              size="sm"
              onClick={handleCreate}
              disabled={createSecret.status === "pending"}
            >
              {createSecret.status === "pending" && (
                <IconSpinner className="size-3" />
              )}
              Store & use
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
