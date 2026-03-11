import { createServer } from "node:http";

import { HttpApiBuilder, HttpServer, OpenApi } from "@effect/platform";
import { NodeHttpServer } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  createControlPlaneApiLayer,
  createSqlControlPlaneRuntime,
  type LocalInstallation,
  type Source,
  type SqlControlPlaneRuntime,
} from "@executor/control-plane";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import * as Schema from "effect/Schema";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot } from "react-dom/client";

import {
  ExecutorReactProvider,
  setExecutorApiBaseUrl,
  type Loadable,
  useCreateSource,
  useRemoveSource,
  useSource,
  useSourceInspection,
  useSources,
  useUpdateSource,
} from "./index";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://127.0.0.1/",
});

globalThis.window = dom.window as unknown as typeof globalThis.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", {
  value: dom.window.navigator,
  configurable: true,
});
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.Event = dom.window.Event;
globalThis.EventTarget = dom.window.EventTarget;

globalThis.requestAnimationFrame = (callback: FrameRequestCallback) =>
  setTimeout(() => callback(Date.now()), 0) as unknown as number;
globalThis.cancelAnimationFrame = (handle: number) => {
  clearTimeout(handle);
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type DelayRule = {
  method: string;
  pathname: RegExp;
  durationMs: number;
};

type RunningServer = {
  baseUrl: string;
  close: () => Promise<void>;
};

type ApiServer = RunningServer & {
  runtime: SqlControlPlaneRuntime;
};

type HookHarness<T> = {
  current: T | null;
  unmount: () => Promise<void>;
};

type CreateHarnessState = {
  sources: Loadable<ReadonlyArray<Source>>;
  createSource: ReturnType<typeof useCreateSource>;
};

type SourceHarnessState = {
  sources: Loadable<ReadonlyArray<Source>>;
  source: Loadable<Source>;
  inspection: ReturnType<typeof useSourceInspection>;
  updateSource: ReturnType<typeof useUpdateSource>;
  removeSource: ReturnType<typeof useRemoveSource>;
};

const closeScope = (scope: Scope.CloseableScope) =>
  Scope.close(scope, Exit.void).pipe(Effect.orDie);

const startControlPlaneServer = async (): Promise<ApiServer> => {
  const runtime = await Effect.runPromise(
    createSqlControlPlaneRuntime({ localDataDir: ":memory:" }),
  );
  const scope = await Effect.runPromise(Scope.make());

  try {
    const serverLayer = HttpApiBuilder.serve().pipe(
      Layer.provide(createControlPlaneApiLayer(runtime.runtimeLayer)),
      Layer.provideMerge(NodeHttpServer.layerTest),
    );
    const context = await Effect.runPromise(Layer.buildWithScope(serverLayer, scope));
    const server = Context.get(context, HttpServer.HttpServer);

    return {
      runtime,
      baseUrl: HttpServer.formatAddress(server.address),
      close: async () => {
        await Effect.runPromise(closeScope(scope));
        await runtime.close();
      },
    };
  } catch (error) {
    await Effect.runPromise(closeScope(scope));
    await runtime.close();
    throw error;
  }
};

const startProxyServer = async (input: {
  targetBaseUrl: string;
  delays?: ReadonlyArray<DelayRule>;
}): Promise<RunningServer> => {
  const server = createServer(async (req, res) => {
    try {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const rule = input.delays?.find(
        (candidate) =>
          candidate.method === method && candidate.pathname.test(url.pathname),
      );

      if (rule) {
        await new Promise((resolve) => setTimeout(resolve, rule.durationMs));
      }

      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined) {
          continue;
        }

        if (Array.isArray(value)) {
          value.forEach((item) => headers.append(name, item));
          continue;
        }

        headers.set(name, value);
      }
      headers.delete("host");

      const bodyChunks: Array<Uint8Array> = [];
      for await (const chunk of req) {
        bodyChunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      }

      const targetUrl = new URL(`${url.pathname}${url.search}`, input.targetBaseUrl);
      const response = await fetch(targetUrl, {
        method,
        headers,
        body: bodyChunks.length > 0 ? Buffer.concat(bodyChunks) : undefined,
      });

      res.statusCode = response.status;
      response.headers.forEach((value, name) => {
        res.setHeader(name, value);
      });
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      res.statusCode = 500;
      res.end(error instanceof Error ? error.message : String(error));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind proxy server");
  }

  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      }),
  };
};

type OpenApiSpecServer = RunningServer & {
  specUrl: string;
};

const startOpenApiSpecServer = async (): Promise<OpenApiSpecServer> => {
  const spec = {
    openapi: "3.0.3",
    info: {
      title: "Hook Test API",
      version: "1.0.0",
    },
    paths: {
      "/ping": {
        get: {
          operationId: "ping",
          responses: {
            200: {
              description: "ok",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      ok: { type: "boolean" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  const server = createServer((req, res) => {
    if (req.url === "/openapi.json") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(spec));
      return;
    }

    if (req.url === "/ping") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.statusCode = 404;
    res.end("not found");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind OpenAPI spec server");
  }

  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    specUrl: `${baseUrl}/openapi.json`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      }),
  };
};

async function requestJson<T>(input: {
  baseUrl: string;
  path: string;
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  payload?: unknown;
  accountId?: string;
}): Promise<T> {
  const response = await fetch(new URL(input.path, input.baseUrl), {
    method: input.method ?? "GET",
    headers: {
      ...(input.accountId ? { "x-executor-account-id": input.accountId } : {}),
      ...(input.payload !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(input.payload !== undefined
      ? {
          body: JSON.stringify(input.payload),
        }
      : {}),
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response.json() as Promise<T>;
}

const getInstallation = (baseUrl: string) =>
  requestJson<LocalInstallation>({
    baseUrl,
    path: "/v1/local/installation",
  });

const seedStoredOpenApiSource = async (input: {
  server: ApiServer;
  installation: LocalInstallation;
  name: string;
  specUrl?: string;
}): Promise<Source> => {
  const sourceDocumentText = JSON.stringify({
    openapi: "3.0.3",
    info: {
      title: input.name,
      version: "1.0.0",
    },
    paths: {
      "/ping": {
        get: {
          operationId: "ping",
          responses: {
            200: {
              description: "ok",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      ok: { type: "boolean" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
  const specUrl = input.specUrl ?? `data:application/json,${encodeURIComponent(sourceDocumentText)}`;

  return requestJson<Source>({
    baseUrl: input.server.baseUrl,
    path: `/v1/workspaces/${input.installation.workspaceId}/sources`,
    method: "POST",
    accountId: input.installation.accountId,
    payload: {
      name: input.name,
      kind: "openapi",
      endpoint: "https://example.com/api",
      status: "connected",
      enabled: true,
      namespace: "hooks-test",
      binding: {
        specUrl,
      },
      auth: {
        kind: "none",
      },
    },
  });
};

async function renderExecutorHarness<T>(useValue: () => T): Promise<HookHarness<T>> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const snapshot: { current: T | null } = { current: null };

  const Probe = () => {
    const value = useValue();

    React.useLayoutEffect(() => {
      snapshot.current = value;
    }, [value]);

    return null;
  };

  await React.act(async () => {
    root.render(
      <ExecutorReactProvider>
        <Probe />
      </ExecutorReactProvider>,
    );
  });

  return {
    get current() {
      return snapshot.current;
    },
    unmount: async () => {
      await React.act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

const renderCreateHarness = () =>
  renderExecutorHarness<CreateHarnessState>(() => ({
    sources: useSources(),
    createSource: useCreateSource(),
  }));

const renderSourceHarness = (sourceId: string) =>
  renderExecutorHarness<SourceHarnessState>(() => ({
    sources: useSources(),
    source: useSource(sourceId),
    inspection: useSourceInspection(sourceId),
    updateSource: useUpdateSource(),
    removeSource: useRemoveSource(),
  }));

async function waitForValue<T>(
  read: () => T | null,
  predicate: (value: T) => boolean,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const value = read();
    if (value !== null && predicate(value)) {
      return value;
    }

    await React.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }

  throw new Error("Timed out waiting for test state");
}

function isReady<T>(
  loadable: Loadable<T>,
): loadable is { status: "ready"; data: T } {
  return loadable.status === "ready";
}

function getReadyData<T>(loadable: Loadable<T>): T {
  if (!isReady(loadable)) {
    throw new Error("Expected loadable data to be ready");
  }

  return loadable.data;
}


describe("executor-react source hooks", () => {
  it.effect("rejects invalid source creation before applying optimistic state", () =>
    Effect.promise(async () => {
    const apiServer = await startControlPlaneServer();
    const proxyServer = await startProxyServer({
      targetBaseUrl: apiServer.baseUrl,
      delays: [
        {
          method: "POST",
          pathname: /^\/v1\/workspaces\/[^/]+\/sources$/,
          durationMs: 150,
        },
      ],
    });

    setExecutorApiBaseUrl(proxyServer.baseUrl);

    const harness = await renderCreateHarness();

    try {
      await waitForValue(
        () => harness.current,
        (value) => isReady(value.sources) && value.sources.data.length === 0,
      );

      let mutationPromise!: Promise<{ ok: true; value: Source } | { ok: false; error: unknown }>;
      await React.act(async () => {
        mutationPromise = harness.current!.createSource.mutateAsync({
          name: "" as never,
          kind: "openapi",
          endpoint: "https://example.com",
          binding: {
            specUrl: "https://example.com/openapi.json",
          },
        }).then(
          (value) => ({ ok: true as const, value }),
          (error) => ({ ok: false as const, error }),
        );
        await Promise.resolve();
      });

      const failed = await waitForValue(
        () => harness.current,
        (value) =>
          value.createSource.status === "error"
          && isReady(value.sources)
          && value.sources.data.length === 0,
      );

      const result = await mutationPromise;
      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error("Expected invalid source creation to fail");
      }

      expect(result.error).toBeInstanceOf(Error);
      expect(failed.createSource.error).toBeInstanceOf(Error);
    } finally {
      await harness.unmount();
      await proxyServer.close();
      await apiServer.close();
    }
    }),
  );

  it.effect("applies optimistic source updates and refreshes live inspection data after success", () =>
    Effect.promise(async () => {
    const apiServer = await startControlPlaneServer();
    const proxyServer = await startProxyServer({
      targetBaseUrl: apiServer.baseUrl,
      delays: [
        {
          method: "PATCH",
          pathname: /^\/v1\/workspaces\/[^/]+\/sources\/[^/]+$/,
          durationMs: 150,
        },
      ],
    });
    const specServer = await startOpenApiSpecServer();

    setExecutorApiBaseUrl(proxyServer.baseUrl);

    try {
      const installation = await getInstallation(apiServer.baseUrl);
      const source = await seedStoredOpenApiSource({
        server: apiServer,
        installation,
        name: "Original Source",
        specUrl: specServer.specUrl,
      });
      const harness = await renderSourceHarness(source.id);

      try {
        await waitForValue(
          () => harness.current,
          (value) =>
            isReady(value.sources)
            && isReady(value.source)
            && isReady(value.inspection)
            && value.source.data.name === "Original Source"
            && value.inspection.data.source.name === "Original Source",
        );

        let mutationPromise!: Promise<Source>;
        await React.act(async () => {
          mutationPromise = harness.current!.updateSource.mutateAsync({
            sourceId: source.id,
            payload: {
              name: "Renamed Source",
            },
          });
          await Promise.resolve();
        });

        const optimistic = await waitForValue(
          () => harness.current,
          (value) =>
            value.updateSource.status === "pending"
            && isReady(value.sources)
            && isReady(value.source)
            && isReady(value.inspection)
            && value.sources.data.some((item) => item.id === source.id && item.name === "Renamed Source")
            && value.source.data.name === "Renamed Source"
            && value.inspection.data.source.name === "Original Source",
        );

        expect(getReadyData(optimistic.source).name).toBe("Renamed Source");
        expect(getReadyData(optimistic.inspection).source.name).toBe("Original Source");

        let updated!: Source;
        await React.act(async () => {
          updated = await mutationPromise;
        });

        expect(updated.name).toBe("Renamed Source");

        const refreshed = await waitForValue(
          () => harness.current,
          (value) =>
            value.updateSource.status === "success"
            && isReady(value.source)
            && isReady(value.inspection)
            && value.source.data.name === "Renamed Source"
            && value.inspection.data.source.name === "Renamed Source",
        );

        expect(getReadyData(refreshed.inspection).source.name).toBe("Renamed Source");
      } finally {
        await harness.unmount();
      }
    } finally {
      await specServer.close();
      await proxyServer.close();
      await apiServer.close();
    }
    }),
  );

  it.effect("optimistically removes deleted sources and invalidates mounted source queries", () =>
    Effect.promise(async () => {
    const apiServer = await startControlPlaneServer();
    const proxyServer = await startProxyServer({
      targetBaseUrl: apiServer.baseUrl,
      delays: [
        {
          method: "DELETE",
          pathname: /^\/v1\/workspaces\/[^/]+\/sources\/[^/]+$/,
          durationMs: 150,
        },
      ],
    });

    setExecutorApiBaseUrl(proxyServer.baseUrl);

    try {
      const installation = await getInstallation(apiServer.baseUrl);
      const source = await seedStoredOpenApiSource({
        server: apiServer,
        installation,
        name: "Disposable Source",
      });
      const harness = await renderSourceHarness(source.id);

      try {
        await waitForValue(
          () => harness.current,
          (value) =>
            isReady(value.sources)
            && isReady(value.source)
            && isReady(value.inspection)
            && value.sources.data.some((item) => item.id === source.id),
        );

        let mutationPromise!: Promise<{ removed: boolean }>;
        await React.act(async () => {
          mutationPromise = harness.current!.removeSource.mutateAsync(source.id);
          await Promise.resolve();
        });

        const optimistic = await waitForValue(
          () => harness.current,
          (value) =>
            value.removeSource.status === "pending"
            && isReady(value.sources)
            && !value.sources.data.some((item) => item.id === source.id),
        );

        expect(
          getReadyData(optimistic.sources).some((item: Source) => item.id === source.id),
        ).toBe(false);

        let removed!: { removed: boolean };
        await React.act(async () => {
          removed = await mutationPromise;
        });

        expect(removed.removed).toBe(true);

        const invalidated = await waitForValue(
          () => harness.current,
          (value) =>
            value.removeSource.status === "success"
            && isReady(value.sources)
            && value.sources.data.length === 0
            && value.source.status === "error"
            && value.inspection.status === "error",
        );

        expect(invalidated.source.status).toBe("error");
        expect(invalidated.inspection.status).toBe("error");
      } finally {
        await harness.unmount();
      }
    } finally {
      await proxyServer.close();
      await apiServer.close();
    }
    }),
  );

  it.effect("surfaces missing sources as errors instead of staying loading", () =>
    Effect.promise(async () => {
      const apiServer = await startControlPlaneServer();
      setExecutorApiBaseUrl(apiServer.baseUrl);

      try {
        const harness = await renderSourceHarness("src_missing");

        try {
          const missing = await waitForValue(
            () => harness.current,
            (value) =>
              isReady(value.sources)
              && value.sources.data.length === 0
              && value.source.status === "error"
              && value.inspection.status === "error",
          );

          expect(missing.source.status).toBe("error");
          expect(missing.inspection.status).toBe("error");
          if (missing.source.status === "error") {
            expect(missing.source.error.message).toContain("Source not found");
          }
          if (missing.inspection.status === "error") {
            expect(missing.inspection.error.message).toContain("Source not found");
          }
        } finally {
          await harness.unmount();
        }
      } finally {
        await apiServer.close();
      }
    }),
  );
});
