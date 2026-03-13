import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import {
  createServer as createNodeServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, extname, resolve } from "node:path";
import { Readable } from "node:stream";
import { HttpApiBuilder, HttpServer } from "@effect/platform";
import {
  createControlPlaneApiLayer,
  createSqlControlPlaneRuntime,
  type ResolveExecutionEnvironment,
  type ResolveSecretMaterial,
  type SqlControlPlaneRuntime,
} from "@executor/control-plane";
import { createExecutorMcpRequestHandler } from "@executor/executor-mcp";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

import {
  DEFAULT_LEGACY_LOCAL_DATA_DIRS,
  DEFAULT_LOCAL_DATA_DIR,
  DEFAULT_SERVER_LOG_FILE,
  DEFAULT_SERVER_PID_FILE,
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
} from "./config";

export {
  DEFAULT_EXECUTOR_DATA_DIR,
  DEFAULT_EXECUTOR_HOME,
  DEFAULT_LOCAL_DATA_DIR,
  DEFAULT_SERVER_BASE_URL,
  DEFAULT_SERVER_LOG_FILE,
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PID_FILE,
  DEFAULT_SERVER_PORT,
  EXECUTOR_DATA_DIR_ENV,
  EXECUTOR_HOME_ENV,
  EXECUTOR_LOCAL_DATA_DIR_ENV,
  EXECUTOR_MIGRATIONS_DIR_ENV,
  EXECUTOR_SERVER_PID_FILE_ENV,
  EXECUTOR_SERVER_LOG_FILE_ENV,
  EXECUTOR_WEB_ASSETS_DIR_ENV,
  SERVER_POLL_INTERVAL_MS,
  SERVER_START_TIMEOUT_MS,
} from "./config";

type StaticUiOptions = {
  readonly assetsDir?: string;
  readonly devServerUrl?: string;
};

export type LocalExecutorServer = {
  readonly runtime: SqlControlPlaneRuntime;
  readonly port: number;
  readonly host: string;
  readonly baseUrl: string;
};

export type StartLocalExecutorServerOptions = {
  readonly port?: number;
  readonly host?: string;
  readonly localDataDir?: string;
  readonly migrationsFolder?: string;
  readonly pidFile?: string;
  readonly executionResolver?: ResolveExecutionEnvironment;
  readonly resolveSecretMaterial?: ResolveSecretMaterial;
  readonly ui?: StaticUiOptions;
};

export type LocalExecutorRequestHandler = {
  readonly runtime: SqlControlPlaneRuntime;
  readonly handleApiRequest: (request: Request) => Promise<Response>;
  readonly getBaseUrl: () => string | undefined;
  readonly setBaseUrl: (baseUrl: string) => void;
};

type ControlPlaneWebHandler = ReturnType<typeof HttpApiBuilder.toWebHandler>;
type ExecutorMcpHandler = ReturnType<typeof createExecutorMcpRequestHandler>;

const disposeRuntime = (runtime: SqlControlPlaneRuntime) =>
  Effect.tryPromise({
    try: () => runtime.close(),
    catch: (cause) =>
      cause instanceof Error ? cause : new Error(String(cause ?? "runtime close failed")),
  }).pipe(Effect.orDie);

const createRuntime = (
  localDataDir: string,
  getLocalServerBaseUrl: () => string | undefined,
  options: StartLocalExecutorServerOptions,
) =>
  createSqlControlPlaneRuntime({
    localDataDir,
    migrationsFolder: options.migrationsFolder,
    executionResolver: options.executionResolver,
    resolveSecretMaterial: options.resolveSecretMaterial,
    getLocalServerBaseUrl,
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof Error ? cause : new Error(String(cause)),
    ),
  );

const moveLegacyLocalDataDir = (
  legacyLocalDataDir: string,
  requestedLocalDataDir: string,
 ) =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(requestedLocalDataDir), { recursive: true });
      if (existsSync(requestedLocalDataDir)) {
        const backupPath = `${requestedLocalDataDir}.backup-${Date.now()}`;
        await rename(requestedLocalDataDir, backupPath);
        console.warn(
          `[executor] Backed up unreadable local data dir to: ${backupPath}`,
        );
      }
      await rename(legacyLocalDataDir, requestedLocalDataDir);
      console.warn(
        `[executor] Moved legacy local data dir to: ${requestedLocalDataDir}`,
      );
    },
    catch: (cause) =>
      cause instanceof Error ? cause : new Error(String(cause)),
  });

const createRuntimeWithLegacyMigration = (
  requestedLocalDataDir: string,
  legacyLocalDataDirs: ReadonlyArray<string>,
  getLocalServerBaseUrl: () => string | undefined,
  options: StartLocalExecutorServerOptions,
 ) =>
  Effect.gen(function* () {
    if (
      requestedLocalDataDir !== ":memory:"
      && !existsSync(requestedLocalDataDir)
      && legacyLocalDataDirs.length > 0
    ) {
      for (const legacyLocalDataDir of legacyLocalDataDirs) {
        const legacyExit = yield* Effect.exit(
          createRuntime(legacyLocalDataDir, getLocalServerBaseUrl, options),
        );
        if (Exit.isFailure(legacyExit)) {
          continue;
        }
        yield* disposeRuntime(legacyExit.value);
        const migrationExit = yield* Effect.exit(
          moveLegacyLocalDataDir(legacyLocalDataDir, requestedLocalDataDir),
        );
        if (Exit.isFailure(migrationExit)) {
          continue;
        }
        const migratedExit = yield* Effect.exit(
          createRuntime(requestedLocalDataDir, getLocalServerBaseUrl, options),
        );
        if (Exit.isSuccess(migratedExit)) {
          return migratedExit.value;
        }
      }
    }
    const primaryExit = yield* Effect.exit(
      createRuntime(requestedLocalDataDir, getLocalServerBaseUrl, options),
    );
    if (Exit.isSuccess(primaryExit)) {
      return primaryExit.value;
    }
    const primaryError = Cause.squash(primaryExit.cause);
    if (legacyLocalDataDirs.length > 0) {
      yield* Effect.sync(() => {
        console.warn(
          `[executor] Failed to open default local data dir: ${requestedLocalDataDir}`,
          primaryError instanceof Error ? primaryError.message : String(primaryError),
        );
      });
    }
    for (const legacyLocalDataDir of legacyLocalDataDirs) {
      const legacyExit = yield* Effect.exit(
        createRuntime(legacyLocalDataDir, getLocalServerBaseUrl, options),
      );
      if (Exit.isFailure(legacyExit)) {
        continue;
      }
      yield* disposeRuntime(legacyExit.value);
      const migrationExit = yield* Effect.exit(
        moveLegacyLocalDataDir(legacyLocalDataDir, requestedLocalDataDir),
      );
      if (Exit.isFailure(migrationExit)) {
        continue;
      }
      const migratedExit = yield* Effect.exit(
        createRuntime(requestedLocalDataDir, getLocalServerBaseUrl, options),
      );
      if (Exit.isSuccess(migratedExit)) {
        return migratedExit.value;
      }
    }
    return yield* Effect.fail(
      primaryError instanceof Error ? primaryError : new Error(String(primaryError)),
    );
  });

const createControlPlaneWebHandler = (runtime: SqlControlPlaneRuntime) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      HttpApiBuilder.toWebHandler(
        Layer.merge(
          HttpApiBuilder.middlewareOpenApi({ path: "/v1/openapi.json" }).pipe(
            Layer.provideMerge(createControlPlaneApiLayer(runtime.runtimeLayer))
          ),
          HttpServer.layerContext,
        ),
      ),
    ),
    (handler: ControlPlaneWebHandler) => Effect.tryPromise({ try: () => handler.dispose(), catch: (cause) => cause instanceof Error ? cause : new Error(String(cause ?? "web handler dispose failed")) }).pipe(Effect.orDie),
  );

const safeFilePath = (assetsDir: string, pathname: string): string | null => {
  const target = resolve(assetsDir, `.${pathname}`);
  const root = resolve(assetsDir);
  return target.startsWith(root) ? target : null;
};

const isRegularFile = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};

const contentTypeByExtension: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const contentTypeForPath = (path: string): string =>
  contentTypeByExtension[extname(path).toLowerCase()] ?? "application/octet-stream";

const readResponseFile = async (
  path: string,
  contentType?: string,
): Promise<Response> => {
  const body = await readFile(path);
  return new Response(body, {
    headers: {
      "content-type": contentType ?? contentTypeForPath(path),
    },
  });
};

const toWebRequest = (nodeRequest: IncomingMessage): Request => {
  const host = nodeRequest.headers.host ?? "127.0.0.1";
  const url = `http://${host}${nodeRequest.url ?? "/"}`;
  const headers = new Headers();

  for (const [key, value] of Object.entries(nodeRequest.headers)) {
    if (value === undefined) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
      continue;
    }

    headers.set(key, value);
  }

  const method = nodeRequest.method ?? "GET";
  const requestInit: RequestInit & { duplex?: "half" } = {
    method,
    headers,
  };

  if (method !== "GET" && method !== "HEAD") {
    requestInit.body = Readable.toWeb(nodeRequest) as unknown as BodyInit;
    requestInit.duplex = "half";
  }

  return new Request(url, requestInit);
};

const writeNodeResponse = async (
  nodeResponse: ServerResponse,
  webResponse: Response,
): Promise<void> => {
  nodeResponse.statusCode = webResponse.status;
  webResponse.headers.forEach((value, key) => {
    nodeResponse.setHeader(key, value);
  });

  if (!webResponse.body) {
    nodeResponse.end();
    return;
  }

  const reader = webResponse.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    nodeResponse.write(Buffer.from(value));
  }

  nodeResponse.end();
};


const wantsHtml = (request: Request): boolean =>
  request.headers.get("accept")?.includes("text/html") ?? false;

const serveUiAsset = async (request: Request, ui: StaticUiOptions): Promise<Response | null> => {
  const url = new URL(request.url);

  if (ui.devServerUrl) {
    const proxyUrl = new URL(`${url.pathname}${url.search}`, ui.devServerUrl);
    return fetch(new Request(proxyUrl.toString(), request));
  }

  if (!ui.assetsDir) {
    return null;
  }

  const candidatePath = safeFilePath(ui.assetsDir, url.pathname);
  if (candidatePath && await isRegularFile(candidatePath)) {
    return readResponseFile(candidatePath);
  }

  const shouldServeIndex =
    url.pathname === "/"
    || extname(url.pathname).length === 0
    || wantsHtml(request);

  if (!shouldServeIndex) {
    return null;
  }

  const indexPath = resolve(ui.assetsDir, "index.html");
  if (!(await isRegularFile(indexPath))) {
    return null;
  }

  return readResponseFile(indexPath, "text/html; charset=utf-8");
};

const isApiRequest = (request: Request): boolean => {
  const pathname = new URL(request.url).pathname;
  return pathname === "/mcp" || pathname === "/v1" || pathname.startsWith("/v1/");
};

export const createLocalExecutorRequestHandler = (
  options: StartLocalExecutorServerOptions = {},
): Effect.Effect<LocalExecutorRequestHandler, Error, Scope.Scope> =>
  Effect.gen(function* () {
    const requestedLocalDataDir = options.localDataDir ?? DEFAULT_LOCAL_DATA_DIR;
    const legacyLocalDataDirs =
      options.localDataDir === undefined
        ? DEFAULT_LEGACY_LOCAL_DATA_DIRS.filter((candidate) => existsSync(candidate))
        : [];

    if (requestedLocalDataDir !== ":memory:") {
      yield* Effect.tryPromise({
        try: () => mkdir(dirname(requestedLocalDataDir), { recursive: true }),
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      });
    }

    let baseUrlRef: string | undefined;

    const runtime = yield* Effect.acquireRelease(
      createRuntimeWithLegacyMigration(
        requestedLocalDataDir,
        legacyLocalDataDirs,
        () => baseUrlRef,
        options,
      ),
      disposeRuntime,
    );

    const apiHandler = yield* createControlPlaneWebHandler(runtime);
    const mcpHandler = yield* Effect.acquireRelease(
      Effect.sync(() => createExecutorMcpRequestHandler(runtime)),
      (handler: ExecutorMcpHandler) =>
        Effect.tryPromise({
          try: () => handler.close(),
          catch: (cause) =>
            cause instanceof Error
              ? cause
              : new Error(String(cause ?? "mcp handler close failed")),
        }).pipe(Effect.orDie),
    );

    return {
      runtime,
      handleApiRequest: (request) => {
        const pathname = new URL(request.url).pathname;
        return pathname === "/mcp"
          ? mcpHandler.handleRequest(request)
          : apiHandler.handler(request);
      },
      getBaseUrl: () => baseUrlRef,
      setBaseUrl: (baseUrl) => {
        baseUrlRef = baseUrl;
      },
    } satisfies LocalExecutorRequestHandler;
  });

export const createLocalExecutorServer = (
  options: StartLocalExecutorServerOptions = {},
): Effect.Effect<LocalExecutorServer, Error, Scope.Scope> =>
  Effect.gen(function* () {
    const host = options.host ?? DEFAULT_SERVER_HOST;
    const port = options.port ?? DEFAULT_SERVER_PORT;
    const requestHandler = yield* createLocalExecutorRequestHandler(options);

    const server = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          new Promise<ReturnType<typeof createNodeServer>>((resolveServer, reject) => {
            const server = createNodeServer((nodeRequest, nodeResponse) => {
              void (async () => {
                const request = toWebRequest(nodeRequest);
                const response = isApiRequest(request)
                  ? await requestHandler.handleApiRequest(request)
                  : await serveUiAsset(request, options.ui ?? {}) ?? new Response("Not Found", { status: 404 });
                await writeNodeResponse(nodeResponse, response);
              })().catch((cause) => {
                nodeResponse.statusCode = 500;
                nodeResponse.end(cause instanceof Error ? cause.message : String(cause));
              });
            });

            server.once("error", reject);
            server.listen(port, host, () => {
              server.off("error", reject);
              resolveServer(server);
            });
          }),
        catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
      }),
      (server) => Effect.tryPromise({
        try: () =>
          new Promise<void>((resolveClose, reject) => {
            server.close((error) => {
              if (error) {
                reject(error);
                return;
              }

              resolveClose();
            });
          }),
        catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
      }).pipe(Effect.orDie),
    );

    const address = server.address();
    if (!address || typeof address === "string") {
      return yield* Effect.fail(new Error("Failed to resolve local executor server address"));
    }

    const resolvedAddress = address as AddressInfo;
    const baseUrl = `http://${host}:${resolvedAddress.port}`;
    requestHandler.setBaseUrl(baseUrl);

    return {
      runtime: requestHandler.runtime,
      host,
      port: resolvedAddress.port,
      baseUrl,
    } satisfies LocalExecutorServer;
  });

export const runLocalExecutorServer = (
  options: StartLocalExecutorServerOptions = {},
): Effect.Effect<void, Error, never> =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* createLocalExecutorServer(options);
      const pidFile = options.pidFile ?? DEFAULT_SERVER_PID_FILE;

      yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: async () => {
            await mkdir(dirname(pidFile), { recursive: true });
            await writeFile(pidFile, JSON.stringify({
              pid: process.pid,
              port: server.port,
              host: server.host,
              baseUrl: server.baseUrl,
              startedAt: Date.now(),
              logFile: DEFAULT_SERVER_LOG_FILE,
            }, null, 2));
          },
          catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
        }),
        () => Effect.tryPromise({
          try: () => rm(pidFile, { force: true }),
          catch: (cause) =>
            cause instanceof Error ? cause : new Error(String(cause ?? "pid file cleanup failed")),
        }).pipe(Effect.orDie),
      );

      console.error(`executor server listening on ${server.baseUrl}`);

      yield* Effect.async<void, never>((resume) => {
        const shutdown = () => resume(Effect.void);
        process.once("SIGINT", shutdown);
        process.once("SIGTERM", shutdown);

        return Effect.sync(() => {
          process.off("SIGINT", shutdown);
          process.off("SIGTERM", shutdown);
        });
      });
    }),
  );
