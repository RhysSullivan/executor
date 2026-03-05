import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Command, Options } from "@effect/cli";
import { FetchHttpClient } from "@effect/platform";
import { BunContext, BunRuntime } from "@effect/platform-bun";
import {
  createExecutorApiFetchHandler,
  ExecutorControlPlaneBaseUrlHeader,
  type ExecutorApiPrincipal,
} from "@executor-v2/api-http";
import { makeControlPlaneClient } from "@executor-v2/management-api/client";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

type ExecutorTarget = "local" | "cloud";

type ExecutorCliConfig = {
  target?: ExecutorTarget;
  cloudBaseUrl?: string;
  cloudToken?: string;
  cloudRefreshToken?: string;
  cloudAuthClientId?: string;
  cloudAuthBaseUrl?: string;
  workspaceId?: string;
  runScripts?: Record<string, string>;
};

type RequestOptions = {
  method: "GET" | "POST" | "DELETE";
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
};

type WorkspaceRecord = {
  id: string;
};

type InteractionRecord = {
  id: string;
  workspaceId: string;
  taskRunId: string;
  originServer: string;
  originRequestId: string;
  callId: string;
  toolPath: string;
  mode: "form" | "url";
  elicitationId: string | null;
  message: string;
  requestedSchemaJson: string | null;
  url: string | null;
  status: "pending" | "accepted" | "declined" | "cancelled" | "expired" | "failed";
  requestJson: string;
  responseAction: "accept" | "decline" | "cancel" | null;
  responseContentJson: string | null;
  reason: string | null;
  requestedAt: number;
  resolvedAt: number | null;
  completionNotifiedAt: number | null;
  expiresAt: number | null;
};

type McpToolsListTool = {
  name?: string;
  description?: string;
};

type McpToolsListResponse = {
  result?: {
    tools?: Array<McpToolsListTool>;
  };
  error?: {
    message?: string;
  };
};

type DeviceAuthorizationResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
};

type CloudAuthTokenResponse = {
  access_token: string;
  refresh_token?: string;
  organization_id?: string;
  user?: {
    id?: string;
    email?: string;
  };
};

type CommonTargetOptions = {
  target: Option.Option<ExecutorTarget>;
  workspace: Option.Option<string>;
  baseUrl: Option.Option<string>;
  json: boolean;
};

type InteractionModeOption = "auto" | "user" | "agent";

type ExecuteRunResponse = {
  runId: string;
  status: "completed" | "failed" | "timed_out" | "denied" | "waiting_for_interaction";
  result?: unknown;
  error?: string;
  exitCode?: number;
  durationMs?: number;
  interactionId?: string;
};

type InteractionRequiredEnvelope = {
  status: "interaction_required";
  runId: string;
  interactionId: string;
  mode: InteractionRecord["mode"];
  message: string;
  url: string | null;
  expiresAt: number | null;
  resumeCommand: string;
};

const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:8788";
const DEFAULT_WORKOS_AUTH_BASE_URL = "https://api.workos.com";
const CONFIG_PATH = join(homedir(), ".config", "executor", "cli.json");

const toErrorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const trimTrailingSlash = (input: string): string =>
  input.endsWith("/") ? input.slice(0, -1) : input;

const normalizeCloudBaseUrl = (input: string): string => {
  try {
    const url = new URL(input);
    const isLocalhost =
      url.hostname === "localhost"
      || url.hostname === "127.0.0.1"
      || url.hostname === "::1";

    if (isLocalhost && (url.pathname === "/" || url.pathname === "")) {
      url.pathname = "/api/control-plane";
    }

    return trimTrailingSlash(url.toString());
  } catch {
    return trimTrailingSlash(input);
  }
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

const optionToUndefined = <A>(option: Option.Option<A>): A | undefined =>
  Option.getOrUndefined(option);

const resolveInteractionMode = (value: InteractionModeOption | undefined): "user" | "agent" => {
  if (value === "user" || value === "agent") {
    return value;
  }

  return stdin.isTTY && stdout.isTTY ? "user" : "agent";
};

const tokenExpiresAtEpochSeconds = (token: string): number | null => {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
};

const isTokenStale = (token: string, skewSeconds = 30): boolean => {
  const exp = tokenExpiresAtEpochSeconds(token);
  if (exp === null) {
    return false;
  }
  const now = Math.floor(Date.now() / 1000);
  return exp <= now + skewSeconds;
};

const cleanEnv = (): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  return env;
};

const openInBrowser = (url: string): void => {
  const cmd =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];

  Bun.spawn({
    cmd,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
};

const printOutput = (value: unknown, asJson: boolean): void => {
  if (asJson) {
    stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      stdout.write("(empty)\n");
      return;
    }

    for (const item of value) {
      stdout.write(`${JSON.stringify(item)}\n`);
    }
    return;
  }

  if (typeof value === "object" && value !== null) {
    stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }

  stdout.write(`${String(value)}\n`);
};

const safeParseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

const isTarget = (value: string | undefined): value is ExecutorTarget =>
  value === "local" || value === "cloud";

const normalizeRunScripts = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const output: Record<string, string> = {};
  for (const [runId, script] of Object.entries(value as Record<string, unknown>)) {
    if (typeof runId !== "string" || typeof script !== "string") {
      continue;
    }

    const trimmedRunId = runId.trim();
    const trimmedScript = script.trim();
    if (trimmedRunId.length === 0 || trimmedScript.length === 0) {
      continue;
    }

    output[trimmedRunId] = trimmedScript;
  }

  return output;
};

const rememberRunScript = (config: ExecutorCliConfig, runId: string, code: string): void => {
  const trimmedRunId = runId.trim();
  if (trimmedRunId.length === 0) {
    return;
  }

  const trimmedCode = code.trim();
  if (trimmedCode.length === 0) {
    return;
  }

  const existing = normalizeRunScripts(config.runScripts);
  config.runScripts = {
    ...existing,
    [trimmedRunId]: trimmedCode,
  };
};

const loadConfig = async (): Promise<ExecutorCliConfig> => {
  const file = Bun.file(CONFIG_PATH);
  if (!(await file.exists())) {
    return {};
  }

  try {
    const parsed = JSON.parse(await file.text()) as ExecutorCliConfig;
    return {
      ...(isTarget(parsed.target) ? { target: parsed.target } : {}),
      ...(typeof parsed.cloudBaseUrl === "string"
        ? { cloudBaseUrl: parsed.cloudBaseUrl }
        : {}),
      ...(typeof parsed.cloudToken === "string" ? { cloudToken: parsed.cloudToken } : {}),
      ...(typeof parsed.cloudRefreshToken === "string"
        ? { cloudRefreshToken: parsed.cloudRefreshToken }
        : {}),
      ...(typeof parsed.cloudAuthClientId === "string"
        ? { cloudAuthClientId: parsed.cloudAuthClientId }
        : {}),
      ...(typeof parsed.cloudAuthBaseUrl === "string"
        ? { cloudAuthBaseUrl: parsed.cloudAuthBaseUrl }
        : {}),
      ...(typeof parsed.workspaceId === "string" ? { workspaceId: parsed.workspaceId } : {}),
      ...(typeof parsed.runScripts === "object"
        ? { runScripts: normalizeRunScripts(parsed.runScripts) }
        : {}),
    };
  } catch {
    return {};
  }
};

const saveConfig = async (config: ExecutorCliConfig): Promise<void> => {
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await Bun.write(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
};

const pickTarget = async (
  config: ExecutorCliConfig,
  explicit?: ExecutorTarget,
): Promise<ExecutorTarget> => {
  if (explicit) {
    return explicit;
  }

  if (config.target) {
    return config.target;
  }

  if (!stdin.isTTY || !stdout.isTTY) {
    return "local";
  }

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(
      "First run: connect Executor to local or cloud? [local/cloud] (default: local) ",
    ))
      .trim()
      .toLowerCase();
    return answer === "cloud" ? "cloud" : "local";
  } finally {
    rl.close();
  }
};

const promptCloudConfig = async (
  existing: ExecutorCliConfig,
): Promise<Pick<ExecutorCliConfig, "cloudBaseUrl" | "cloudToken">> => {
  if (!stdin.isTTY || !stdout.isTTY) {
    return {
      cloudBaseUrl: existing.cloudBaseUrl,
      cloudToken: existing.cloudToken,
    };
  }

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const urlAnswer = (await rl.question(
      `Cloud base URL${existing.cloudBaseUrl ? ` [${existing.cloudBaseUrl}]` : ""}: `,
    )).trim();
    const tokenAnswer = (await rl.question(
      `Cloud bearer token${existing.cloudToken ? " [saved]" : ""} (optional): `,
    )).trim();

    return {
      cloudBaseUrl: urlAnswer.length > 0 ? urlAnswer : existing.cloudBaseUrl,
      cloudToken: tokenAnswer.length > 0 ? tokenAnswer : existing.cloudToken,
    };
  } finally {
    rl.close();
  }
};

class ExecutorServerClient {
  readonly #target: ExecutorTarget;
  readonly #config: ExecutorCliConfig;
  readonly #baseUrlOverride?: string;
  #localProcess: Bun.Subprocess | null = null;

  constructor(target: ExecutorTarget, config: ExecutorCliConfig, baseUrlOverride?: string) {
    this.#target = target;
    this.#config = config;
    this.#baseUrlOverride = baseUrlOverride?.trim();
  }

  async close(): Promise<void> {
    if (!this.#localProcess) {
      return;
    }

    this.#localProcess.kill();
    await this.#localProcess.exited.catch(() => undefined);
    this.#localProcess = null;
  }

  async request<T>(options: RequestOptions): Promise<T> {
    const baseUrl = await this.#resolveBaseUrl();
    const url = `${baseUrl}${options.path}`;
    const headers = await this.#buildHeaders();
    if (options.headers) {
      Object.assign(headers, options.headers);
    }
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const response = await fetch(url, {
      method: options.method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    const text = await response.text();
    const payload = text.length === 0 ? null : safeParseJson(text);

    if (!response.ok) {
      const detail =
        typeof payload === "object" && payload && "error" in payload
          ? String((payload as { error: unknown }).error)
          : text;
      throw new Error(
        `Request failed (${response.status} ${response.statusText}) for ${options.method} ${options.path}${detail ? `: ${detail}` : ""}`,
      );
    }

    return payload as T;
  }

  async runControlPlane<T>(
    operation: (client: any) => Effect.Effect<T, unknown>,
  ): Promise<T> {
    const baseUrl = await this.#resolveBaseUrl();
    const headers = await this.#buildHeaders();

    const program = Effect.gen(function* () {
      const client = yield* makeControlPlaneClient({ baseUrl, headers });
      return yield* operation(client);
    });

    return Effect.runPromise(program.pipe(Effect.provide(FetchHttpClient.layer)));
  }

  async resolveBaseUrl(): Promise<string> {
    return this.#resolveBaseUrl();
  }

  async #buildHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };

    if (this.#target === "cloud") {
      const envToken = process.env.EXECUTOR_CLOUD_TOKEN?.trim();
      const token = envToken && envToken.length > 0
        ? envToken
        : await this.#resolveCloudAccessToken();
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
      return headers;
    }

    headers["x-executor-account-id"] =
      process.env.EXECUTOR_LOCAL_ACCOUNT_ID?.trim() || "acct_local";
    return headers;
  }

  async #resolveCloudAccessToken(): Promise<string | undefined> {
    const configuredToken = this.#config.cloudToken?.trim();
    const staleConfiguredToken = configuredToken ? isTokenStale(configuredToken) : false;

    if (configuredToken && !staleConfiguredToken) {
      return configuredToken;
    }

    const refreshed = await this.#refreshCloudAccessToken();
    if (refreshed) {
      return refreshed;
    }

    if (configuredToken && staleConfiguredToken) {
      throw new Error(
        "Cloud access token expired and could not be refreshed. Run `executor auth login --client-id <WORKOS_CLIENT_ID>`.",
      );
    }

    return configuredToken || undefined;
  }

  async #refreshCloudAccessToken(): Promise<string | undefined> {
    const refreshToken = this.#config.cloudRefreshToken?.trim();
    if (!refreshToken) {
      return undefined;
    }

    const clientId =
      process.env.EXECUTOR_CLOUD_AUTH_CLIENT_ID?.trim()
      || process.env.WORKOS_CLIENT_ID?.trim()
      || this.#config.cloudAuthClientId?.trim();
    if (!clientId) {
      return undefined;
    }

    const authBaseUrl =
      process.env.EXECUTOR_CLOUD_AUTH_BASE_URL?.trim()
      || this.#config.cloudAuthBaseUrl?.trim()
      || DEFAULT_WORKOS_AUTH_BASE_URL;

    const response = await postForm(
      `${trimTrailingSlash(authBaseUrl)}/user_management/authenticate`,
      {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
      },
      20000,
    );

    if (!response.ok || !response.payload || typeof response.payload !== "object") {
      return undefined;
    }

    const payload = response.payload as Record<string, unknown>;
    const accessToken = typeof payload.access_token === "string"
      ? payload.access_token
      : undefined;
    if (!accessToken) {
      return undefined;
    }

    this.#config.cloudToken = accessToken;
    this.#config.cloudAuthClientId = clientId;
    this.#config.cloudAuthBaseUrl = authBaseUrl;

    if (typeof payload.refresh_token === "string" && payload.refresh_token.length > 0) {
      this.#config.cloudRefreshToken = payload.refresh_token;
    }

    await saveConfig(this.#config);
    return accessToken;
  }

  async #resolveBaseUrl(): Promise<string> {
    if (this.#baseUrlOverride && this.#baseUrlOverride.length > 0) {
      return this.#target === "cloud"
        ? normalizeCloudBaseUrl(this.#baseUrlOverride)
        : trimTrailingSlash(this.#baseUrlOverride);
    }

    if (this.#target === "cloud") {
      const cloudBaseUrl =
        process.env.EXECUTOR_CLOUD_URL?.trim()
        || this.#config.cloudBaseUrl?.trim()
        || "";
      if (cloudBaseUrl.length === 0) {
        throw new Error(
          "Cloud target selected but no base URL configured. Set EXECUTOR_CLOUD_URL or run `executor init --target cloud --cloud-url <url>`.",
        );
      }
      return normalizeCloudBaseUrl(cloudBaseUrl);
    }

    const localBaseUrl =
      process.env.EXECUTOR_LOCAL_URL?.trim() || DEFAULT_LOCAL_BASE_URL;

    if (await this.#isHealthy(localBaseUrl)) {
      return localBaseUrl;
    }

    await this.#spawnLocalServer(localBaseUrl);
    return localBaseUrl;
  }

  async #isHealthy(baseUrl: string): Promise<boolean> {
    try {
      const response = await fetch(`${baseUrl}/healthz`, {
        signal: AbortSignal.timeout(800),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async #spawnLocalServer(baseUrl: string): Promise<void> {
    if (this.#localProcess) {
      return;
    }

    const bunBinary = process.execPath;
    const candidateMain = process.argv[1] && process.argv[1].length > 0
      ? resolve(process.argv[1])
      : resolve(import.meta.dir, "main.ts");
    const localPort = (() => {
      try {
        const parsed = new URL(baseUrl);
        return parsed.port.length > 0 ? parsed.port : "8788";
      } catch {
        return "8788";
      }
    })();
    const childEnv = {
      ...cleanEnv(),
      PORT: localPort,
      EXECUTOR_RUNTIME_KIND:
        process.env.EXECUTOR_LOCAL_RUNTIME_KIND?.trim() || "local-inproc",
      PM_RUNTIME_KIND:
        process.env.EXECUTOR_LOCAL_RUNTIME_KIND?.trim() || "local-inproc",
    };

    this.#localProcess = Bun.spawn({
      cmd: [bunBinary, candidateMain, "__local-server", "--port", localPort],
      cwd: process.cwd(),
      env: childEnv,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });

    const started = await this.#waitForHealthy(baseUrl, 10000);
    if (started) {
      return;
    }

    let stderrText = "";
    if (this.#localProcess.stderr && typeof this.#localProcess.stderr !== "number") {
      stderrText = (await new Response(this.#localProcess.stderr).text()).trim();
    }

    const exitCode = await this.#localProcess.exited.catch(() => undefined);
    this.#localProcess = null;
    throw new Error(
      `Failed to start local Executor server subprocess.${typeof exitCode === "number" ? ` Exit code: ${exitCode}.` : ""}${stderrText.length > 0 ? ` ${stderrText}` : ""}`,
    );
  }

  async #waitForHealthy(baseUrl: string, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await this.#isHealthy(baseUrl)) {
        return true;
      }

      if (this.#localProcess && typeof this.#localProcess.exitCode === "number") {
        return false;
      }

      await sleep(200);
    }

    return false;
  }
}

const ensureWorkspaceId = async (
  client: ExecutorServerClient,
  config: ExecutorCliConfig,
  workspaceOverride?: string,
): Promise<string> => {
  if (workspaceOverride && workspaceOverride.trim().length > 0) {
    return workspaceOverride.trim();
  }

  const workspaces = await client.runControlPlane((api) =>
    api.workspaces.list({}),
  ) as Array<WorkspaceRecord>;

  if (!Array.isArray(workspaces) || workspaces.length === 0) {
    throw new Error("No workspaces available. Create one first through the control plane API.");
  }

  const configuredWorkspaceId = config.workspaceId?.trim();
  if (
    configuredWorkspaceId
    && workspaces.some((workspace) => workspace.id === configuredWorkspaceId)
  ) {
    return configuredWorkspaceId;
  }

  const workspaceId = workspaces[0].id;
  config.workspaceId = workspaceId;
  await saveConfig(config);
  return workspaceId;
};

const postForm = async (
  url: string,
  params: Record<string, string>,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; payload: unknown }> => {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const text = await response.text();
  const payload = text.length === 0 ? null : safeParseJson(text);
  return { ok: response.ok, status: response.status, payload };
};

const requestDeviceAuthorization = async (
  authBaseUrl: string,
  clientId: string,
): Promise<DeviceAuthorizationResponse> => {
  const url = `${trimTrailingSlash(authBaseUrl)}/user_management/authorize/device`;
  const response = await postForm(url, { client_id: clientId }, 15000);

  if (!response.ok || !response.payload || typeof response.payload !== "object") {
    throw new Error(
      `Device authorization failed (${response.status}): ${JSON.stringify(response.payload)}`,
    );
  }

  const payload = response.payload as Record<string, unknown>;
  const deviceCode = typeof payload.device_code === "string" ? payload.device_code : null;
  const userCode = typeof payload.user_code === "string" ? payload.user_code : null;
  const verificationUri =
    typeof payload.verification_uri === "string" ? payload.verification_uri : null;
  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : null;
  const interval = typeof payload.interval === "number" ? payload.interval : null;

  if (!deviceCode || !userCode || !verificationUri || !expiresIn || !interval) {
    throw new Error("Device authorization response missing required fields.");
  }

  return {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: verificationUri,
    verification_uri_complete:
      typeof payload.verification_uri_complete === "string"
        ? payload.verification_uri_complete
        : undefined,
    expires_in: expiresIn,
    interval,
  };
};

const pollForCloudTokens = async (input: {
  authBaseUrl: string;
  clientId: string;
  deviceCode: string;
  intervalSeconds: number;
  expiresInSeconds: number;
}): Promise<CloudAuthTokenResponse> => {
  const url = `${trimTrailingSlash(input.authBaseUrl)}/user_management/authenticate`;
  const startedAt = Date.now();
  let pollIntervalSeconds = Math.max(1, input.intervalSeconds);

  while (Date.now() - startedAt < input.expiresInSeconds * 1000) {
    const response = await postForm(
      url,
      {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: input.deviceCode,
        client_id: input.clientId,
      },
      20000,
    );

    if (response.ok && response.payload && typeof response.payload === "object") {
      const payload = response.payload as Record<string, unknown>;
      if (typeof payload.access_token === "string") {
        return {
          access_token: payload.access_token,
          ...(typeof payload.refresh_token === "string"
            ? { refresh_token: payload.refresh_token }
            : {}),
          ...(typeof payload.organization_id === "string"
            ? { organization_id: payload.organization_id }
            : {}),
          ...(payload.user && typeof payload.user === "object"
            ? {
                user: {
                  ...(typeof (payload.user as Record<string, unknown>).id === "string"
                    ? { id: (payload.user as Record<string, unknown>).id as string }
                    : {}),
                  ...(typeof (payload.user as Record<string, unknown>).email === "string"
                    ? { email: (payload.user as Record<string, unknown>).email as string }
                    : {}),
                },
              }
            : {}),
        };
      }
    }

    const errorCode =
      response.payload && typeof response.payload === "object"
        ? (response.payload as { error?: unknown }).error
        : undefined;

    if (errorCode === "authorization_pending") {
      await sleep(pollIntervalSeconds * 1000);
      continue;
    }

    if (errorCode === "slow_down") {
      pollIntervalSeconds += 1;
      await sleep(pollIntervalSeconds * 1000);
      continue;
    }

    if (errorCode === "access_denied") {
      throw new Error("Authentication denied.");
    }

    if (errorCode === "expired_token") {
      throw new Error("Authentication timed out.");
    }

    throw new Error(
      `Authentication failed (${response.status}): ${JSON.stringify(response.payload)}`,
    );
  }

  throw new Error("Authentication timed out waiting for authorization.");
};

const withClient = async (
  common: CommonTargetOptions,
  execute: (input: {
    client: ExecutorServerClient;
    config: ExecutorCliConfig;
    workspaceOverride?: string;
    asJson: boolean;
  }) => Promise<void>,
): Promise<void> => {
  const config = await loadConfig();
  const explicitTarget = optionToUndefined(common.target);
  const target = await pickTarget(config, explicitTarget);
  if (!config.target && !explicitTarget) {
    config.target = target;
    await saveConfig(config);
  }
  const client = new ExecutorServerClient(
    target,
    config,
    optionToUndefined(common.baseUrl),
  );

  try {
    await execute({
      client,
      config,
      workspaceOverride: optionToUndefined(common.workspace),
      asJson: common.json,
    });
  } finally {
    await client.close();
  }
};

const commonTargetOptions = () => ({
  target: Options.choice("target", ["local", "cloud"]).pipe(Options.optional),
  workspace: Options.text("workspace").pipe(Options.optional),
  baseUrl: Options.text("base-url").pipe(Options.optional),
  json: Options.boolean("json"),
});

const startEmbeddedLocalServer = async (port: number): Promise<void> => {
  process.env.EXECUTOR_RUNTIME_KIND =
    process.env.EXECUTOR_LOCAL_RUNTIME_KIND?.trim() || "local-inproc";
  process.env.PM_RUNTIME_KIND = process.env.EXECUTOR_RUNTIME_KIND;

  const {
    createLocalPrincipal,
    getControlPlaneRuntime,
    provisionPrincipal,
  } = await import("../../web/lib/control-plane/server");

  const runtime = await getControlPlaneRuntime();
  const defaultWorkspaceId = process.env.EXECUTOR_LOCAL_WORKSPACE_ID?.trim() || "ws_local";
  const principal = {
    ...createLocalPrincipal(),
    accountId: "acct_local",
    subject: "local:local",
    displayName: "Local",
    organizationId: "org_local",
    workspaceId: defaultWorkspaceId,
  } as ExecutorApiPrincipal;

  const fetchHandler = createExecutorApiFetchHandler({
    handlers: {
      handleControlPlane: runtime.handleControlPlane,
      handleMcp: runtime.handleMcp,
      handleAdminMcp: runtime.handleAdminMcp,
      handleRuntimeToolCall: runtime.handleRuntimeToolCall,
      executeRun: runtime.executeRun,
    },
    resolvePrincipal: async () => principal,
    ensurePrincipal: (nextPrincipal) => provisionPrincipal(runtime, nextPrincipal as any),
    healthServiceName: "executor-local-server",
    defaultMcpWorkspaceId: defaultWorkspaceId,
  });

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch: fetchHandler,
  });

  await new Promise<void>((resolvePromise) => {
    let settled = false;
    const cleanup = () => {
      if (settled) {
        return;
      }
      settled = true;
      server.stop(true);
      void runtime.dispose().finally(resolvePromise);
    };

    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
  });
};

const authStatusCommand = Command.make("status", { json: Options.boolean("json") }, ({ json }) =>
  Effect.tryPromise({
    try: async () => {
      const config = await loadConfig();
      printOutput(
        {
          target: config.target ?? null,
          authenticatedForCloud: Boolean(config.cloudToken?.trim()),
          cloudBaseUrl: config.cloudBaseUrl ?? null,
          cloudAuthClientId: config.cloudAuthClientId ?? null,
          cloudAuthBaseUrl: config.cloudAuthBaseUrl ?? null,
        },
        json,
      );
    },
    catch: toErrorMessage,
  }),
);

const authLoginCommand = Command.make(
  "login",
  {
    clientId: Options.text("client-id").pipe(Options.optional),
    authBaseUrl: Options.text("auth-base-url").pipe(Options.optional),
    noBrowser: Options.boolean("no-browser"),
    json: Options.boolean("json"),
  },
  ({ clientId, authBaseUrl, noBrowser, json }) =>
    Effect.tryPromise({
      try: async () => {
        const config = await loadConfig();
        const resolvedClientId =
          optionToUndefined(clientId)
          || process.env.EXECUTOR_CLOUD_AUTH_CLIENT_ID
          || process.env.WORKOS_CLIENT_ID
          || config.cloudAuthClientId;

        if (!resolvedClientId) {
          throw new Error(
            "Cloud auth requires a client id. Pass --client-id or set EXECUTOR_CLOUD_AUTH_CLIENT_ID (or WORKOS_CLIENT_ID).",
          );
        }

        const resolvedAuthBaseUrl =
          optionToUndefined(authBaseUrl)
          || process.env.EXECUTOR_CLOUD_AUTH_BASE_URL
          || config.cloudAuthBaseUrl
          || DEFAULT_WORKOS_AUTH_BASE_URL;

        const authorization = await requestDeviceAuthorization(
          resolvedAuthBaseUrl,
          resolvedClientId,
        );

        const verificationUrl =
          authorization.verification_uri_complete ?? authorization.verification_uri;

        if (!json) {
          stdout.write(`Open this URL to authenticate:\n${verificationUrl}\n\n`);
          stdout.write(`Code: ${authorization.user_code}\n`);
        }

        if (!noBrowser) {
          openInBrowser(verificationUrl);
        }

        const token = await pollForCloudTokens({
          authBaseUrl: resolvedAuthBaseUrl,
          clientId: resolvedClientId,
          deviceCode: authorization.device_code,
          intervalSeconds: authorization.interval,
          expiresInSeconds: authorization.expires_in,
        });

        config.target = "cloud";
        config.cloudAuthClientId = resolvedClientId;
        config.cloudAuthBaseUrl = resolvedAuthBaseUrl;
        config.cloudToken = token.access_token;
        config.cloudRefreshToken = token.refresh_token;
        await saveConfig(config);

        printOutput(
          {
            ok: true,
            target: config.target,
            cloudBaseUrl: config.cloudBaseUrl ?? null,
            authenticatedForCloud: true,
            organizationId: token.organization_id ?? null,
            user: token.user ?? null,
          },
          json,
        );
      },
      catch: toErrorMessage,
    }),
).pipe(
  Command.withDescription("Authenticate cloud target using device authorization flow"),
);

const authCommand = Command.make("auth").pipe(
  Command.withSubcommands([authLoginCommand, authStatusCommand] as any),
  Command.withDescription("Cloud authentication commands"),
);

const serverStartCommand = Command.make(
  "start",
  {
    port: Options.integer("port").pipe(Options.withDefault(8788)),
  },
  ({ port }) =>
    Effect.tryPromise({
      try: async () => {
        await startEmbeddedLocalServer(port);
      },
      catch: toErrorMessage,
    }),
).pipe(
  Command.withDescription("Start local Executor API server (foreground)"),
);

const serverCommand = Command.make("server").pipe(
  Command.withSubcommands([serverStartCommand] as any),
  Command.withDescription("Local server host commands"),
);

const initCommand = Command.make(
  "init",
  {
    target: Options.choice("target", ["local", "cloud"]).pipe(Options.optional),
    cloudUrl: Options.text("cloud-url").pipe(Options.optional),
    cloudToken: Options.text("cloud-token").pipe(Options.optional),
    json: Options.boolean("json"),
  },
  ({ target, cloudUrl, cloudToken, json }) =>
    Effect.tryPromise({
      try: async () => {
        const config = await loadConfig();
        const picked = await pickTarget(config, optionToUndefined(target));
        config.target = picked;

        if (picked === "cloud") {
          const prompted = await promptCloudConfig(config);
          config.cloudBaseUrl =
            optionToUndefined(cloudUrl)
            ?? process.env.EXECUTOR_CLOUD_URL
            ?? prompted.cloudBaseUrl;
          config.cloudToken =
            optionToUndefined(cloudToken)
            ?? process.env.EXECUTOR_CLOUD_TOKEN
            ?? prompted.cloudToken;

          if (!config.cloudBaseUrl) {
            throw new Error("Cloud target requires --cloud-url or EXECUTOR_CLOUD_URL.");
          }
        }

        await saveConfig(config);
        printOutput(
          {
            ok: true,
            target: config.target,
            cloudBaseUrl: config.cloudBaseUrl ?? null,
          },
          json,
        );
      },
      catch: toErrorMessage,
    }),
);

const targetShowCommand = Command.make(
  "show",
  {
    target: Options.choice("target", ["local", "cloud"]).pipe(Options.optional),
    json: Options.boolean("json"),
  },
  ({ target, json }) =>
    Effect.tryPromise({
      try: async () => {
        const config = await loadConfig();
        const explicitTarget = optionToUndefined(target);
        const selected = await pickTarget(config, explicitTarget);
        if (!config.target && !explicitTarget) {
          config.target = selected;
          await saveConfig(config);
        }
        printOutput(
          {
            target: selected,
            cloudBaseUrl: config.cloudBaseUrl ?? null,
            workspaceId: config.workspaceId ?? null,
          },
          json,
        );
      },
      catch: toErrorMessage,
    }),
);

const targetUseCommand = Command.make(
  "use",
  {
    target: Options.choice("target", ["local", "cloud"]),
    cloudUrl: Options.text("cloud-url").pipe(Options.optional),
    cloudToken: Options.text("cloud-token").pipe(Options.optional),
    json: Options.boolean("json"),
  },
  ({ target, cloudUrl, cloudToken, json }) =>
    Effect.tryPromise({
      try: async () => {
        const config = await loadConfig();
        config.target = target;

        if (target === "cloud") {
          const resolvedCloudUrl =
            optionToUndefined(cloudUrl)
            || process.env.EXECUTOR_CLOUD_URL
            || config.cloudBaseUrl;
          const resolvedCloudToken =
            optionToUndefined(cloudToken)
            || process.env.EXECUTOR_CLOUD_TOKEN
            || config.cloudToken;

          if (!resolvedCloudUrl) {
            throw new Error("Cloud target requires --cloud-url (or EXECUTOR_CLOUD_URL).");
          }

          config.cloudBaseUrl = resolvedCloudUrl;
          config.cloudToken = resolvedCloudToken;
        }

        await saveConfig(config);
        printOutput({ ok: true, target: config.target }, json);
      },
      catch: toErrorMessage,
    }),
);

const targetCommand = Command.make("target").pipe(
  Command.withSubcommands([targetShowCommand, targetUseCommand] as any),
  Command.withDescription("Executor target selection"),
);

const workspaceCurrentCommand = Command.make(
  "current",
  commonTargetOptions(),
  (common) =>
    Effect.tryPromise({
      try: async () => {
        const config = await loadConfig();
        const workspaceOverride = optionToUndefined((common as CommonTargetOptions).workspace);
        const workspaceId = workspaceOverride?.trim().length
          ? workspaceOverride.trim()
          : (config.workspaceId ?? null);
        printOutput({ workspaceId }, (common as CommonTargetOptions).json);
      },
      catch: toErrorMessage,
    }),
);

const workspaceUseCommand = Command.make(
  "use",
  {
    workspaceId: Options.text("workspace-id"),
    json: Options.boolean("json"),
  },
  ({ workspaceId, json }) =>
    Effect.tryPromise({
      try: async () => {
        const config = await loadConfig();
        config.workspaceId = workspaceId.trim();
        await saveConfig(config);
        printOutput({ ok: true, workspaceId: config.workspaceId }, json);
      },
      catch: toErrorMessage,
    }),
);

const workspaceCommand = Command.make("workspace").pipe(
  Command.withSubcommands([workspaceCurrentCommand, workspaceUseCommand] as any),
  Command.withDescription("Current workspace settings"),
);

const buildInteractionPageUrl = (input: {
  controlPlaneBaseUrl: string;
  workspaceId: string;
  interactionId: string;
}): string | null => {
  const controlPlaneBase = input.controlPlaneBaseUrl.replace(/\/$/, "");

  if (!controlPlaneBase.endsWith("/api/control-plane")) {
    return null;
  }

  const interactionUiBase = controlPlaneBase.replace(/\/api\/control-plane$/, "");

  return `${interactionUiBase}/interactions/${encodeURIComponent(input.workspaceId)}/${encodeURIComponent(input.interactionId)}`;
};

const waitForInteractionResolution = async (input: {
  client: ExecutorServerClient;
  workspaceId: string;
  interactionId: string;
}): Promise<InteractionRecord> => {
  const timeoutAt = Date.now() + 10 * 60_000;

  while (Date.now() < timeoutAt) {
    const interaction = await input.client.request<InteractionRecord>({
      method: "GET",
      path: `/v1/workspaces/${encodeURIComponent(input.workspaceId)}/interactions/${encodeURIComponent(input.interactionId)}`,
    });

    if (interaction.status !== "pending") {
      return interaction;
    }

    await sleep(1_000);
  }

  throw new Error(`Timed out waiting for interaction resolution: ${input.interactionId}`);
};

const resolvePendingInteraction = async (input: {
  client: ExecutorServerClient;
  workspaceId: string;
  interaction: InteractionRecord;
  controlPlaneBaseUrl: string;
}): Promise<void> => {
  const interaction = input.interaction;
  const interactionUrl = buildInteractionPageUrl({
    controlPlaneBaseUrl: input.controlPlaneBaseUrl,
    workspaceId: input.workspaceId,
    interactionId: interaction.id,
  });

  stdout.write(`\nInteraction required: ${interaction.message}\n`);
  stdout.write(`Tool: ${interaction.toolPath}\n`);

  if (!interactionUrl) {
    throw new Error(
      `Cannot open browser interaction page from base URL '${input.controlPlaneBaseUrl}'. Use a web control-plane base like 'http://localhost:3000/api/control-plane' or run with --interaction-mode agent.`,
    );
  }

  stdout.write(`Resolve it in browser:\n${interactionUrl}\n`);

  if (stdin.isTTY && stdout.isTTY) {
    openInBrowser(interactionUrl);
  }

  const resolved = await waitForInteractionResolution({
    client: input.client,
    workspaceId: input.workspaceId,
    interactionId: interaction.id,
  });

  if (
    resolved.status === "declined"
    || resolved.status === "cancelled"
    || resolved.status === "failed"
    || resolved.status === "expired"
  ) {
    throw new Error(
      resolved.reason
      ?? `Interaction was not resolved successfully (${resolved.status}): ${interaction.id}`,
    );
  }
};

const runExecuteWithInteractionLoop = async (input: {
  client: ExecutorServerClient;
  workspaceId: string;
  runId?: string;
  code: string;
  timeoutMs: number | undefined;
  controlPlaneBaseUrl: string;
  interactionMode: InteractionModeOption | undefined;
}): Promise<unknown> => {
  const runId = input.runId ?? `run_${crypto.randomUUID()}`;
  const resolvedMode = resolveInteractionMode(input.interactionMode);

  while (true) {
    const result = await input.client.request<ExecuteRunResponse>({
      method: "POST",
      path: `/execute?workspaceId=${encodeURIComponent(input.workspaceId)}`,
      headers: {
        [ExecutorControlPlaneBaseUrlHeader]: input.controlPlaneBaseUrl,
      },
      body: {
        runId,
        code: input.code,
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      },
    });

    if (result.status !== "waiting_for_interaction") {
      return result;
    }

    let interactionId = result.interactionId;
    if (!interactionId) {
      const runInteractions = await input.client.request<Array<InteractionRecord>>({
        method: "GET",
        path: `/v1/workspaces/${encodeURIComponent(input.workspaceId)}/runs/${encodeURIComponent(runId)}/interactions`,
      });

      const pending = runInteractions.find((item) => item.status === "pending");
      if (!pending) {
        throw new Error(`Run is waiting for interaction but no pending interactions were found: ${runId}`);
      }

      interactionId = pending.id;
    }

    const interaction = await input.client.request<InteractionRecord>({
      method: "GET",
      path: `/v1/workspaces/${encodeURIComponent(input.workspaceId)}/interactions/${encodeURIComponent(interactionId)}`,
    });

    if (resolvedMode === "agent") {
      const resumeCommand =
        `executor run resume --run-id ${runId} --workspace ${input.workspaceId}`;

      return {
        status: "interaction_required",
        runId,
        interactionId,
        mode: interaction.mode,
        message: interaction.message,
        url: interaction.url,
        expiresAt: interaction.expiresAt,
        resumeCommand,
      } satisfies InteractionRequiredEnvelope;
    }

    await resolvePendingInteraction({
      client: input.client,
      workspaceId: input.workspaceId,
      interaction,
      controlPlaneBaseUrl: input.controlPlaneBaseUrl,
    });
  }
};

const resolveCodeFromInput = async (input: {
  code: Option.Option<string>;
  file: Option.Option<string>;
  fallbackCode?: string;
}): Promise<string> => {
  const codeFromFlag = optionToUndefined(input.code)?.trim();
  const filePath = optionToUndefined(input.file)?.trim();
  const codeFromFile = filePath && filePath.length > 0
    ? (await Bun.file(filePath).text()).trim()
    : undefined;
  const code = codeFromFile && codeFromFile.length > 0
    ? codeFromFile
    : (codeFromFlag && codeFromFlag.length > 0
      ? codeFromFlag
      : (input.fallbackCode?.trim().length ? input.fallbackCode.trim() : undefined));

  if (!code) {
    throw new Error("Run execution requires --code or --file.");
  }

  return code;
};

const runExecuteCommand = Command.make(
  "execute",
  {
    ...commonTargetOptions(),
    code: Options.text("code").pipe(Options.optional),
    file: Options.text("file").pipe(Options.optional),
    timeoutMs: Options.integer("timeout-ms").pipe(Options.optional),
    interactionMode: Options.choice("interaction-mode", ["auto", "user", "agent"] as const).pipe(
      Options.optional,
    ),
  },
  (input) =>
    Effect.tryPromise({
      try: async () => {
        const code = await resolveCodeFromInput(input);

        const common: CommonTargetOptions = {
          target: input.target,
          workspace: input.workspace,
          baseUrl: input.baseUrl,
          json: input.json,
        };

        await withClient(common, async ({ client, config, workspaceOverride, asJson }) => {
          const controlPlaneBaseUrl = await client.resolveBaseUrl();
          const workspaceId = await ensureWorkspaceId(client, config, workspaceOverride);

          const result = await runExecuteWithInteractionLoop({
            client,
            workspaceId,
            code,
            timeoutMs: Option.isSome(input.timeoutMs) ? input.timeoutMs.value : undefined,
            controlPlaneBaseUrl,
            interactionMode: optionToUndefined(input.interactionMode),
          });

          if (
            typeof result === "object"
            && result !== null
            && typeof (result as { runId?: unknown }).runId === "string"
          ) {
            rememberRunScript(config, (result as { runId: string }).runId, code);
            await saveConfig(config);
          }

          printOutput(result, asJson);

          if (
            typeof result === "object"
            && result !== null
            && (result as { status?: unknown }).status === "interaction_required"
          ) {
            process.exitCode = 20;
          }
        });
      },
      catch: toErrorMessage,
    }),
).pipe(
  Command.withDescription("Execute JavaScript against configured runtime"),
);

const runResumeCommand = Command.make(
  "resume",
  {
    ...commonTargetOptions(),
    runId: Options.text("run-id"),
    code: Options.text("code").pipe(Options.optional),
    file: Options.text("file").pipe(Options.optional),
    timeoutMs: Options.integer("timeout-ms").pipe(Options.optional),
    interactionMode: Options.choice("interaction-mode", ["auto", "user", "agent"] as const).pipe(
      Options.optional,
    ),
  },
  (input) =>
    Effect.tryPromise({
      try: async () => {
        const runId = input.runId.trim();
        if (runId.length === 0) {
          throw new Error("Run resume requires --run-id.");
        }

        const common: CommonTargetOptions = {
          target: input.target,
          workspace: input.workspace,
          baseUrl: input.baseUrl,
          json: input.json,
        };

        await withClient(common, async ({ client, config, workspaceOverride, asJson }) => {
          const code = await resolveCodeFromInput({
            ...input,
            fallbackCode: config.runScripts?.[runId],
          });
          const controlPlaneBaseUrl = await client.resolveBaseUrl();
          const workspaceId = await ensureWorkspaceId(client, config, workspaceOverride);

          const result = await runExecuteWithInteractionLoop({
            client,
            workspaceId,
            runId,
            code,
            timeoutMs: Option.isSome(input.timeoutMs) ? input.timeoutMs.value : undefined,
            controlPlaneBaseUrl,
            interactionMode: optionToUndefined(input.interactionMode),
          });

          if (
            typeof result === "object"
            && result !== null
            && typeof (result as { runId?: unknown }).runId === "string"
          ) {
            rememberRunScript(config, (result as { runId: string }).runId, code);
            await saveConfig(config);
          }

          printOutput(result, asJson);

          if (
            typeof result === "object"
            && result !== null
            && (result as { status?: unknown }).status === "interaction_required"
          ) {
            process.exitCode = 20;
          }
        });
      },
      catch: toErrorMessage,
    }),
).pipe(
  Command.withDescription("Resume a paused run by re-invoking with the same run id"),
);

const runDescribeCommand = Command.make(
  "describe",
  {
    ...commonTargetOptions(),
    toolExposureMode: Options.choice("tool-exposure-mode", ["sources_only", "all_tools"]).pipe(
      Options.optional,
    ),
  },
  (input) =>
    Effect.tryPromise({
      try: async () => {
        const common: CommonTargetOptions = {
          target: input.target,
          workspace: input.workspace,
          baseUrl: input.baseUrl,
          json: input.json,
        };

        await withClient(common, async ({ client, config, workspaceOverride, asJson }) => {
          const workspaceId = await ensureWorkspaceId(client, config, workspaceOverride);
          const controlPlaneBaseUrl = await client.resolveBaseUrl();
          const toolExposureMode = optionToUndefined(input.toolExposureMode);

          const queryParts = [
            `workspaceId=${encodeURIComponent(workspaceId)}`,
            ...(toolExposureMode
              ? [`toolExposureMode=${encodeURIComponent(toolExposureMode)}`]
              : []),
          ];

          const response = await client.request<McpToolsListResponse>({
            method: "POST",
            path: `/v1/mcp?${queryParts.join("&")}`,
            headers: {
              Accept: "application/json, text/event-stream",
              [ExecutorControlPlaneBaseUrlHeader]: controlPlaneBaseUrl,
            },
            body: {
              jsonrpc: "2.0",
              id: "executor-cli-tools-list",
              method: "tools/list",
              params: {},
            },
          });

          if (response.error?.message) {
            throw new Error(response.error.message);
          }

          const executeTool = response.result?.tools?.find((tool) => tool.name === "executor.execute");
          const description =
            typeof executeTool?.description === "string"
              ? executeTool.description.trim()
              : "";

          if (description.length === 0) {
            throw new Error("Executor execute tool description is unavailable.");
          }

          if (asJson) {
            printOutput(
              {
                workspaceId,
                toolExposureMode: toolExposureMode ?? "sources_only",
                description,
              },
              true,
            );
            return;
          }

          stdout.write(`${description}\n`);
        });
      },
      catch: toErrorMessage,
    }),
).pipe(
  Command.withDescription("Show execute tool description with namespace/tool context"),
);

const runCommand = Command.make("run").pipe(
  Command.withSubcommands([runExecuteCommand, runResumeCommand, runDescribeCommand] as any),
  Command.withDescription("Code execution commands"),
);

const root = Command.make("executor").pipe(
  Command.withSubcommands([
    initCommand,
    authCommand,
    serverCommand,
    targetCommand,
    workspaceCommand,
    runCommand,
  ] as any),
  Command.withDescription("Executor CLI"),
);

const runCli = Command.run(root, {
  name: "executor",
  version: "0.1.0",
});

const runInternalLocalServerIfRequested = (): Effect.Effect<void, unknown, never> | null => {
  if (process.argv[2] !== "__local-server") {
    return null;
  }

  const portFlagIndex = process.argv.findIndex((arg) => arg === "--port");
  const rawPort =
    portFlagIndex >= 0 && process.argv[portFlagIndex + 1]
      ? process.argv[portFlagIndex + 1]
      : undefined;
  const parsedPort = rawPort ? Number(rawPort) : NaN;
  const port = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : 8788;

  return Effect.tryPromise({
    try: async () => {
      await startEmbeddedLocalServer(port);
    },
    catch: toErrorMessage,
  }).pipe(Effect.provide(BunContext.layer as any)) as Effect.Effect<void, unknown, never>;
};

const program = runInternalLocalServerIfRequested()
  ?? (runCli(process.argv).pipe(
    Effect.provide(BunContext.layer as any),
  ) as Effect.Effect<void, unknown, never>);

BunRuntime.runMain(program);
