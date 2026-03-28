import {
  FileSystem,
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  OpenApi,
} from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { startOpenApiTestServer } from "@executor/effect-test-utils";
import type {
  LocalInstallation,
  Source,
} from "@executor/platform-sdk/schema";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";

import {
  ExecutorReactProvider,
  setExecutorApiBaseUrl,
  type Loadable,
  useLocalInstallation,
  useRemoveSource,
  useSource,
  useSourceInspection,
  useSources,
} from "./index";
import { createLocalExecutorServer } from "../../../platform/server/src/index";

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

type RunningServer = {
  baseUrl: string;
  close: () => Promise<void>;
};

type HookHarness<T> = {
  current: T | null;
  unmount: () => Promise<void>;
};

type WorkspaceHarnessState = {
  installation: Loadable<LocalInstallation>;
  sources: Loadable<ReadonlyArray<Source>>;
};

type SourceHarnessState = {
  sources: Loadable<ReadonlyArray<Source>>;
  source: Loadable<Source>;
  inspection: ReturnType<typeof useSourceInspection>;
  removeSource: ReturnType<typeof useRemoveSource>;
};

const closeScope = (scope: Scope.CloseableScope) =>
  Scope.close(scope, Exit.void).pipe(Effect.orDie);

const startControlPlaneServer = async (): Promise<RunningServer> => {
  const workspaceRoot = await Effect.runPromise(
    FileSystem.FileSystem.pipe(
      Effect.flatMap((fs) =>
        fs.makeTempDirectory({ prefix: "executor-react-test-" })),
      Effect.provide(NodeFileSystem.layer),
    ),
  );
  const scope = await Effect.runPromise(Scope.make());

  try {
    const server = await Effect.runPromise(
      createLocalExecutorServer({
        port: 0,
        localDataDir: ":memory:",
        workspaceRoot,
      }).pipe(Effect.provideService(Scope.Scope, scope)),
    );

    return {
      baseUrl: server.baseUrl,
      close: async () => {
        await Effect.runPromise(closeScope(scope));
      },
    };
  } catch (error) {
    await Effect.runPromise(closeScope(scope));
    throw error;
  }
};

class HooksTestPingApi extends HttpApiGroup.make("ping")
  .add(
    HttpApiEndpoint.get("ping")`/ping`
      .addSuccess(
        Schema.Struct({
          ok: Schema.Boolean,
        }),
      ),
  )
{}

class HooksTestOpenApi extends HttpApi.make("hooksTest").add(HooksTestPingApi) {}

const hooksTestOpenApiSpec = OpenApi.fromApi(HooksTestOpenApi);
const hooksTestOpenApiLayer = HttpApiBuilder.api(HooksTestOpenApi).pipe(
  Layer.provide(
    HttpApiBuilder.group(HooksTestOpenApi, "ping", (handlers) =>
      handlers.handle("ping", () =>
        Effect.succeed({
          ok: true,
        })),
    ),
  ),
);

const startOpenApiSpecServer = async (): Promise<OpenApiSpecServer> =>
  startOpenApiTestServer({
    apiLayer: hooksTestOpenApiLayer,
  });

async function requestJson<T>(input: {
  baseUrl: string;
  path: string;
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
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
  server: RunningServer;
  installation: LocalInstallation;
  name: string;
  specUrl?: string;
}): Promise<Source> => {
  const sourceDocumentText = JSON.stringify(hooksTestOpenApiSpec);
  const specUrl = input.specUrl
    ?? `data:application/json,${encodeURIComponent(sourceDocumentText)}`;

  return requestJson<Source>({
    baseUrl: input.server.baseUrl,
    path: `/v1/workspaces/${input.installation.scopeId}/plugins/openapi/sources`,
    method: "POST",
    accountId: input.installation.actorScopeId,
    payload: {
      name: input.name,
      specUrl,
      baseUrl: "https://example.com/api",
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

const renderWorkspaceHarness = () =>
  renderExecutorHarness<WorkspaceHarnessState>(() => ({
    installation: useLocalInstallation(),
    sources: useSources(),
  }));

const renderSourceHarness = (sourceId: string) =>
  renderExecutorHarness<SourceHarnessState>(() => ({
    sources: useSources(),
    source: useSource(sourceId),
    inspection: useSourceInspection(sourceId),
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

type OpenApiSpecServer = RunningServer & {
  specUrl: string;
};

describe("executor-react source hooks", () => {
  it("loads the local installation, sources, and inspection data", async () => {
    const apiServer = await startControlPlaneServer();
    const specServer = await startOpenApiSpecServer();

    setExecutorApiBaseUrl(apiServer.baseUrl);

    try {
      const installation = await getInstallation(apiServer.baseUrl);
      const source = await seedStoredOpenApiSource({
        server: apiServer,
        installation,
        name: "Hooks Test Source",
        specUrl: specServer.specUrl,
      });

      const workspaceHarness = await renderWorkspaceHarness();
      const sourceHarness = await renderSourceHarness(source.id);

      try {
        const workspace = await waitForValue(
          () => workspaceHarness.current,
          (value) =>
            isReady(value.installation)
            && isReady(value.sources)
            && value.installation.data.scopeId === installation.scopeId
            && value.sources.data.some((item) => item.id === source.id),
        );

        expect(workspace.installation.status).toBe("ready");
        expect(workspace.sources.status).toBe("ready");

        const loaded = await waitForValue(
          () => sourceHarness.current,
          (value) =>
            isReady(value.source)
            && isReady(value.inspection)
            && value.source.data.name === "Hooks Test Source"
            && value.inspection.data.source.id === source.id
            && value.inspection.data.toolCount > 0,
        );

        if (!isReady(loaded.source) || !isReady(loaded.inspection)) {
          throw new Error("Expected source and inspection to be ready");
        }

        expect(loaded.inspection.data.namespace).toBe("hooks-test-source");
        expect(loaded.inspection.data.source.name).toBe("Hooks Test Source");
        expect(loaded.inspection.data.tools[0]?.path).toContain("ping");
      } finally {
        await sourceHarness.unmount();
        await workspaceHarness.unmount();
      }
    } finally {
      await specServer.close();
      await apiServer.close();
    }
  }, 60_000);

  it("invalidates mounted source and inspection queries after removal", async () => {
    const apiServer = await startControlPlaneServer();
    const specServer = await startOpenApiSpecServer();

    setExecutorApiBaseUrl(apiServer.baseUrl);

    try {
      const installation = await getInstallation(apiServer.baseUrl);
      const source = await seedStoredOpenApiSource({
        server: apiServer,
        installation,
        name: "Disposable Source",
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
            && value.sources.data.some((item) => item.id === source.id),
        );

        const removed = await React.act(async () =>
          harness.current!.removeSource.mutateAsync(source.id));
        expect(removed.removed).toBe(true);

        const invalidated = await waitForValue(
          () => harness.current,
          (value) =>
            isReady(value.sources)
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
      await specServer.close();
      await apiServer.close();
    }
  }, 60_000);

  it("surfaces missing sources as errors instead of staying loading", async () => {
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
  }, 60_000);
});
