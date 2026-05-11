import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Context, Effect } from "effect";

import { addGroup, capture } from "@executor-js/api";
import type { GoogleDiscoveryAddSourceInput, GoogleDiscoveryPluginExtension } from "../sdk/plugin";
import { GoogleDiscoveryStoredSourceSchema } from "../sdk/stored-source";
import { GoogleDiscoveryGroup } from "./group";

// ---------------------------------------------------------------------------
// Service tag
//
// Holds the `Captured` shape — every method's `StorageFailure` channel
// has been swapped for `InternalError({ traceId })`. The host app
// provides an already-wrapped extension via
// `Layer.succeed(GoogleDiscoveryExtensionService, withCapture(executor.googleDiscovery))`.
// Handlers see `InternalError` in the error union, which matches
// `.addError(InternalError)` on the group — no per-handler translation.
// ---------------------------------------------------------------------------

export class GoogleDiscoveryExtensionService extends Context.Service<
  GoogleDiscoveryExtensionService,
  GoogleDiscoveryPluginExtension
>()("GoogleDiscoveryExtensionService") {}

// ---------------------------------------------------------------------------
// Composed API
// ---------------------------------------------------------------------------

const ExecutorApiWithGoogleDiscovery = addGroup(GoogleDiscoveryGroup);

// ---------------------------------------------------------------------------
// Handlers
//
// Each handler is exactly: yield the extension service, call the method,
// return. Plugin SDK errors flow through the typed channel and are
// schema-encoded to 4xx by HttpApi (see group.ts `.addError(...)` calls).
// `StorageFailure` has already been translated to `InternalError` by
// `withCapture` on the service instance; defects bubble up and are
// captured + downgraded to `InternalError(traceId)` by the API-level
// observability middleware.
//
// OAuth start/complete/callback live on the shared `/scopes/:scopeId/oauth/*`
// group in `@executor-js/api` now — the plugin has no OAuth-specific handlers.
// ---------------------------------------------------------------------------

export const GoogleDiscoveryHandlers = HttpApiBuilder.group(
  ExecutorApiWithGoogleDiscovery,
  "googleDiscovery",
  (handlers) =>
    handlers
      .handle("probeDiscovery", ({ payload }) =>
        capture(
          Effect.gen(function* () {
            const ext = yield* GoogleDiscoveryExtensionService;
            return yield* ext.probeDiscovery({
              discoveryUrl: payload.discoveryUrl,
              credentials: payload.credentials,
            });
          }),
        ),
      )
      .handle("addSource", ({ params: path, payload }) =>
        capture(
          Effect.gen(function* () {
            const ext = yield* GoogleDiscoveryExtensionService;
            return yield* ext.addSource({
              ...(payload as Omit<GoogleDiscoveryAddSourceInput, "scope">),
              scope: path.scopeId,
            });
          }),
        ),
      )
      .handle("getSource", ({ params: path }) =>
        capture(
          Effect.gen(function* () {
            const ext = yield* GoogleDiscoveryExtensionService;
            const source = yield* ext.getSource(path.namespace, path.scopeId);
            return source
              ? GoogleDiscoveryStoredSourceSchema.make({
                  namespace: source.namespace,
                  name: source.name,
                  config: source.config,
                })
              : null;
          }),
        ),
      )
      .handle("updateSource", ({ params: path, payload }) =>
        capture(
          Effect.gen(function* () {
            const ext = yield* GoogleDiscoveryExtensionService;
            yield* ext.updateSource(path.namespace, path.scopeId, {
              name: payload.name,
              auth: payload.auth,
            });
            return { updated: true };
          }),
        ),
      ),
);
