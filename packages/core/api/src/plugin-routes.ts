// ---------------------------------------------------------------------------
// Plugin-contributed HttpApi composition.
//
// The host iterates plugins, calls each plugin's `routes()` to get its
// `HttpApiGroup`, and reduces them into a single `HttpApi` for the runtime.
// Each plugin's `handlers()` returns a late-binding Layer keyed by the
// plugin's group identity, with the plugin's `extensionService` Tag left
// as a Layer requirement. The host satisfies that Tag — at boot for
// local (`composePluginHandlers(plugins, executor)`), per-request for
// cloud (`providePluginExtensions(plugins)(executor)` in the auth
// middleware).
//
// Static typing is intentionally loose here: the host composes a
// runtime-arbitrary set of plugin groups, so `FullApi` can't be tracked
// at compile time. Per-endpoint typing lives inside each plugin (its
// own bundled `HttpApi.make(id).add(group)` and its
// `createPluginAtomClient` frontend client). The host only needs the
// runtime composition.
// ---------------------------------------------------------------------------

import { Effect, Layer } from "effect";
import type { Context } from "effect";
import type { HttpApi } from "effect/unstable/httpapi";
import type { AnyPlugin, PluginExtensions } from "@executor-js/sdk";

import { CoreExecutorApi } from "./api";

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

/** Extract the Service-tag identifier (the class itself) from a plugin's
 *  `extensionService` field — used to populate the `provides` clause of
 *  `HttpRouter.middleware<{ provides: ... }>()` from the plugin tuple
 *  without enumerating each Tag by hand at the host.
 *
 *  Helper type indirection (`ExtractServiceId`) forces distribution over
 *  the union of plugin tags — TS only distributes conditionals when the
 *  LHS is a naked type parameter, not a derived type expression. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ExtractServiceId<S> = S extends Context.Service<infer Id, any> ? Id : never;

export type PluginExtensionServices<TPlugins extends readonly AnyPlugin[]> =
  ExtractServiceId<NonNullable<TPlugins[number]["extensionService"]>>;

// The composed `HttpApi` is loosely typed — see file header.
type LooseHttpApi = HttpApi.AnyWithProps;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyLayer = Layer.Layer<any, any, any>;

// Use the field accessor + NonNullable rather than `extends { handlers: ... }`
// because the spec marks `handlers` optional (`handlers?:`); the conditional
// form would fail the match because the field type includes `undefined`.
type ExtractHandlerLayer<P> = NonNullable<
  P extends { readonly handlers?: infer F } ? F : never
> extends () => infer L
  ? L
  : never;

// Compute the union of every plugin's handler-Layer type. Each plugin's
// `handlers()` returns a specific `Layer<Group, never, ExtensionService>`;
// we union them so `Layer.mergeAll(...)`'s output type can be extracted
// without erasing per-plugin requirements.
type PluginHandlerLayers<TPlugins extends readonly AnyPlugin[]> =
  ExtractHandlerLayer<TPlugins[number]>;

// Distribute over the union of handler layers to extract each channel
// individually, then re-pack into a single `Layer<UnionROut, UnionE,
// UnionRIn>` matching what `Layer.mergeAll` produces at runtime. Naive
// `Union extends Layer<infer A, ...>` would distribute and yield a
// union of layers, not a merged layer — these helpers fold instead.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LayerROut<L> = L extends Layer.Layer<infer ROut, any, any> ? ROut : never;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LayerE<L> = L extends Layer.Layer<any, infer E, any> ? E : never;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LayerRIn<L> = L extends Layer.Layer<any, any, infer RIn> ? RIn : never;

type MergedHandlerLayer<TPlugins extends readonly AnyPlugin[]> = Layer.Layer<
  LayerROut<PluginHandlerLayers<TPlugins>>,
  LayerE<PluginHandlerLayers<TPlugins>>,
  LayerRIn<PluginHandlerLayers<TPlugins>>
>;

/**
 * Compose plugin-contributed `HttpApiGroup`s into the core executor API.
 * Plugins without a `routes()` field are skipped.
 */
export const composePluginApi = (
  plugins: readonly AnyPlugin[],
): LooseHttpApi => {
  let api: LooseHttpApi = CoreExecutorApi as unknown as LooseHttpApi;
  for (const plugin of plugins) {
    if (plugin.routes) {
      const group = plugin.routes();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      api = (api as any).add(group);
    }
  }
  return api;
};

/**
 * Build the merged Layer of plugin handler implementations, satisfying
 * each plugin's `extensionService` Tag eagerly from `executor[id]`.
 *
 * Suitable for hosts (like local) that have a single, boot-time
 * executor. Hosts with per-request executors (cloud) should use
 * `composePluginHandlerLayer` + `providePluginExtensions` instead.
 */
export const composePluginHandlers = <TPlugins extends readonly AnyPlugin[]>(
  plugins: TPlugins,
  extensions: PluginExtensions<TPlugins>,
): AnyLayer => {
  const layers: AnyLayer[] = [];
  for (const p of plugins) {
    if (!p.handlers) continue;
    const handlerLayer = p.handlers();
    if (!p.extensionService) {
      layers.push(handlerLayer);
      continue;
    }
    const ext = (extensions as Record<string, unknown>)[p.id];
    layers.push(
      handlerLayer.pipe(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Layer.provide(Layer.succeed(p.extensionService)(ext as any)),
      ),
    );
  }
  if (layers.length === 0) return Layer.empty as unknown as AnyLayer;
  return Layer.mergeAll(...(layers as [AnyLayer, ...AnyLayer[]]));
};

/**
 * Build the merged late-binding Layer of plugin handler implementations
 * WITHOUT satisfying their `extensionService` Tags. Compose into
 * `HttpApiBuilder.layer(FullApi)` at boot; satisfy the Tags per-request
 * via `providePluginExtensions` in an `HttpRouter` middleware.
 *
 * The return type is the union of each plugin's `handlers()` Layer
 * type — that preserves the per-plugin requirements (typically
 * `*ExtensionService` Tags) so the host's `HttpRouter.middleware`
 * recognises them as per-request requires.
 */
export const composePluginHandlerLayer = <
  TPlugins extends readonly AnyPlugin[],
>(
  plugins: TPlugins,
): MergedHandlerLayer<TPlugins> => {
  const layers = plugins.flatMap((p) => (p.handlers ? [p.handlers()] : []));
  if (layers.length === 0) {
    return Layer.empty as unknown as MergedHandlerLayer<TPlugins>;
  }
  return Layer.mergeAll(
    ...(layers as [AnyLayer, ...AnyLayer[]]),
  ) as unknown as MergedHandlerLayer<TPlugins>;
};

/**
 * Per-request helper: fold each plugin's `extensionService` Tag onto an
 * effect via `Effect.provideService(tag, executor[id])`. The plugin
 * spec carries the Tag so the host doesn't import each plugin's
 * `<plugin>/api` subpath directly.
 *
 *   const provide = providePluginExtensions(plugins);
 *   return yield* httpEffect.pipe(provide(requestExecutor));
 */
export const providePluginExtensions =
  <TPlugins extends readonly AnyPlugin[]>(plugins: TPlugins) =>
  (extensions: PluginExtensions<TPlugins>) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, Exclude<R, PluginExtensionServices<TPlugins>>> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let out: Effect.Effect<A, E, any> = effect;
    for (const plugin of plugins) {
      if (!plugin.extensionService) continue;
      const ext = (extensions as Record<string, unknown>)[plugin.id];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      out = out.pipe(Effect.provideService(plugin.extensionService, ext as any));
    }
    return out as Effect.Effect<A, E, Exclude<R, PluginExtensionServices<TPlugins>>>;
  };
