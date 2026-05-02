// Protected-side API wiring. Kept separate from `./layers.ts` so tests
// can import the protected API + shared services without dragging in
// non-protected/org handlers (which transitively import
// `@tanstack/react-start`, unresolvable in the Workers test runtime).

import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { Layer } from "effect";

import { CoreExecutorApi, observabilityMiddleware } from "@executor-js/api";
import {
  CoreHandlers,
  composePluginApi,
  composePluginHandlerLayer,
} from "@executor-js/api/server";
// Type-only Group imports — needed for `HttpApiClient.ForApi<typeof
// ProtectedCloudApi>` to type test clients precisely. Runtime
// composition is data-driven via `composePluginApi(cloudPlugins)`.
// These imports erase at build time and are NOT a fanout of plugin
// runtime wiring.
import type { OpenApiGroup } from "@executor-js/plugin-openapi/api";
import type { McpGroup } from "@executor-js/plugin-mcp/api";
import type { GraphqlGroup } from "@executor-js/plugin-graphql/api";

import executorConfig from "../../executor.config";
import { UserStoreService } from "../auth/context";
import { WorkOSAuth } from "../auth/workos";
import { AutumnService } from "../services/autumn";
import { DbService } from "../services/db";
import { ErrorCaptureLive } from "../observability";

// Plugin list at module-eval time — `plugins({})` is safe because
// `.routes()` doesn't read host deps; the per-request env credentials
// are only consumed when the plugin is actually constructed inside
// `createScopedExecutor`. The schema-gen CLI relies on the same
// property.
const cloudPlugins = executorConfig.plugins({});

// `ProtectedCloudApi` deliberately does NOT declare `.middleware(OrgAuth)`
// — auth + per-request execution stack construction live in a single
// `HttpRouter` middleware (`ExecutionStackMiddleware` in `./protected.ts`)
// which has the right ordering to provide `AuthContext` AND the executor
// services to handlers. Putting auth on the API as `HttpApiMiddleware` ran
// it INSIDE the router middleware (wrong order), and added a second auth
// pass on top of the existing one in `protected.ts`'s outer effect. The
// router-middleware approach folds both into one place.
//
// Runtime composition is via `composePluginApi(cloudPlugins)` (loosely
// typed). The typed cast below recovers the precise group union for
// `HttpApiClient.ForApi<typeof ProtectedCloudApi>` — needed by the
// test harness's typed clients.
type CoreGroups =
  typeof CoreExecutorApi extends HttpApi.HttpApi<string, infer G> ? G : never;

export type ProtectedCloudApiShape = HttpApi.HttpApi<
  "executor",
  CoreGroups | typeof OpenApiGroup | typeof McpGroup | typeof GraphqlGroup
>;

export const ProtectedCloudApi = composePluginApi(
  cloudPlugins,
) as unknown as ProtectedCloudApiShape;

const ObservabilityLive = observabilityMiddleware(ProtectedCloudApi);

const DbLive = DbService.Live;
const UserStoreLive = UserStoreService.Live.pipe(Layer.provide(DbLive));

export const SharedServices = Layer.mergeAll(
  DbLive,
  UserStoreLive,
  WorkOSAuth.Default,
  AutumnService.Default,
  HttpServer.layerServices,
);

export const RouterConfig = Layer.succeed(HttpRouter.RouterConfig)({ maxParamLength: 1000 });

// Every handler the ProtectedCloudApi routes to. Plugin handler layers
// are late-binding — they require their plugin's `extensionService`
// Tag, which the per-request `ExecutionStackMiddleware` satisfies via
// `providePluginExtensions`. The test harness mirrors this; nothing
// else needs to know which plugins are wired.
export const ProtectedCloudApiHandlers = Layer.mergeAll(
  CoreHandlers,
  composePluginHandlerLayer(cloudPlugins),
);

// `ErrorCaptureLive` is provided above the handler + middleware layers
// so the `withCapture` translation path (typed-channel `StorageError →
// InternalError(traceId)`) AND the observability middleware's defect
// catchall both see the same Sentry-backed implementation.
export const ProtectedCloudApiLive = HttpApiBuilder.layer(ProtectedCloudApi).pipe(
  Layer.provide(Layer.mergeAll(ProtectedCloudApiHandlers, ObservabilityLive)),
  Layer.provide(ErrorCaptureLive),
);
