import { HttpApiBuilder } from "effect/unstable/httpapi";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
  HttpServer,
} from "effect/unstable/http";
import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";

import {
  Scope,
  ScopeId,
  createExecutor,
  definePlugin,
  makeTestConfig,
  type Executor,
} from "@executor-js/sdk";

import { ExecutorApi } from "./api";
import { observabilityMiddleware } from "./observability";
import { CoreHandlers, ExecutionEngineService, ExecutorService } from "./server";

const TEST_PLUGIN_ID = "credentialApiTest";
const TEST_SOURCE_ID = "shared-api";
const TEST_SLOT = "request.header.Authorization";

const webHandlerFor = (executor: Executor) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        HttpApiBuilder.layer(ExecutorApi).pipe(
          Layer.provide(CoreHandlers),
          Layer.provide(observabilityMiddleware(ExecutorApi)),
          Layer.provide(Layer.succeed(ExecutorService)(executor)),
          Layer.provide(
            Layer.succeed(ExecutionEngineService)({} as ExecutionEngineService["Service"]),
          ),
          Layer.provideMerge(HttpServer.layerServices),
          Layer.provideMerge(Layer.succeed(HttpRouter.RouterConfig)({ maxParamLength: 1000 })),
        ),
        { disableLogger: true },
      ),
    ),
    (web) => Effect.promise(() => web.dispose()),
  );

const handlerContextFor = (executor: Executor) =>
  Context.make(ExecutorService, executor).pipe(
    Context.add(ExecutionEngineService, {} as ExecutionEngineService["Service"]),
  );

const apiClientFor = (executor: Executor) =>
  Effect.gen(function* () {
    const web = yield* webHandlerFor(executor);
    const context = handlerContextFor(executor);
    const httpClient = HttpClient.make((request, _url, signal) =>
      Effect.gen(function* () {
        const webRequest = yield* HttpClientRequest.toWeb(request, { signal }).pipe(
          Effect.mapError(
            (cause) =>
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.InvalidUrlError({ request, cause }),
              }),
          ),
        );
        const response = yield* Effect.promise(() => web.handler(webRequest, context));
        return HttpClientResponse.fromWeb(request, response);
      }),
    );
    return yield* HttpApiClient.makeWith(ExecutorApi, {
      httpClient,
      baseUrl: "http://localhost",
    });
  });

const scope = (id: ScopeId, name: string) => Scope.make({ id, name, createdAt: new Date() });

const credentialApiTestPlugin = definePlugin(() => ({
  id: TEST_PLUGIN_ID,
  storage: () => ({}),
  extension: (ctx) => ({
    registerSource: (targetScope: ScopeId) =>
      ctx.core.sources.register({
        id: TEST_SOURCE_ID,
        scope: targetScope,
        kind: "test-api",
        name: "Shared API",
        tools: [{ name: "read", description: "read from the shared API" }],
      }),
  }),
}));

describe("credential binding API", () => {
  it.effect("sets, lists, and removes source credential bindings", () =>
    Effect.gen(function* () {
      const userScope = ScopeId.make("api-user");
      const orgScope = ScopeId.make("api-org");
      const executor = yield* createExecutor(
        makeTestConfig({
          scopes: [scope(userScope, "user"), scope(orgScope, "org")],
          plugins: [credentialApiTestPlugin()] as const,
        }),
      );
      yield* executor.credentialApiTest.registerSource(orgScope);
      const client = yield* apiClientFor(executor);

      const created = yield* client.credentialBindings.set({
        params: { scopeId: userScope },
        payload: {
          targetScope: userScope,
          pluginId: TEST_PLUGIN_ID,
          sourceId: TEST_SOURCE_ID,
          sourceScope: orgScope,
          slotKey: TEST_SLOT,
          value: { kind: "text", text: "test-token" },
        },
      });
      expect(created).toMatchObject({
        slotKey: TEST_SLOT,
        scopeId: String(userScope),
        value: { kind: "text", text: "test-token" },
      });

      const listed = yield* client.credentialBindings.listForSource({
        params: {
          scopeId: userScope,
          pluginId: TEST_PLUGIN_ID,
          sourceId: TEST_SOURCE_ID,
          sourceScope: orgScope,
        },
      });
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ slotKey: TEST_SLOT, scopeId: String(userScope) });

      const removed = yield* client.credentialBindings.remove({
        params: { scopeId: userScope },
        payload: {
          targetScope: userScope,
          pluginId: TEST_PLUGIN_ID,
          sourceId: TEST_SOURCE_ID,
          sourceScope: orgScope,
          slotKey: TEST_SLOT,
        },
      });
      expect(removed).toEqual({ removed: true });

      const afterRemove = yield* client.credentialBindings.listForSource({
        params: {
          scopeId: userScope,
          pluginId: TEST_PLUGIN_ID,
          sourceId: TEST_SOURCE_ID,
          sourceScope: orgScope,
        },
      });
      expect(afterRemove).toEqual([]);
    }),
  );
});
