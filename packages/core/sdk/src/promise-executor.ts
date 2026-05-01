// ---------------------------------------------------------------------------
// @executor-js/sdk/promise — thin Promise façade over the Effect SDK.
//
// Consumer goal: use executors + plugins without touching Effect. The
// façade wraps `createExecutor` so it returns a Promise, and proxies
// every method on the returned executor to unwrap its Effect into a
// Promise. Plugin factories are Effect-native but consumers never see
// that — the proxy flattens plugin extension methods too.
//
// Not a goal: authoring plugins in Promise style. The plugin model
// (storage, schema, staticSources, Effect ctx) is Effect-only. Bring
// your own `@executor-js/plugin-*` from the Effect side.
// ---------------------------------------------------------------------------

import { Brand, Effect } from "effect";

import { makeMemoryAdapter } from "@executor-js/storage-core/testing/memory";

import { makeInMemoryBlobStore } from "./blob";
import {
  createExecutor as createEffectExecutor,
  collectSchemas,
  type Executor as EffectExecutor,
  type OnElicitation,
} from "./executor";
import { ScopeId } from "./ids";
import type { AnyPlugin } from "./plugin";
import { Scope } from "./scope";

// ---------------------------------------------------------------------------
// Types
//
// Promise consumers shouldn't need to construct Effect `Brand`s to call into
// the executor — branded ids (`SecretId`, `ScopeId`, `ToolId`, `PolicyId`,
// `ConnectionId`) are typed as `string & Brand<...>` on the Effect side, but
// at runtime they're plain strings. `Unbrand` strips brand tags from
// parameter types (recursively, so it walks into object fields like
// `secrets.set({ id, scope })`) so consumers can pass plain strings. Return
// types are passed through unchanged — caller code that reads `.id` etc.
// off a returned ref still gets the branded type for use as an opaque token.
// ---------------------------------------------------------------------------

type Unbrand<T> = T extends Brand.Brand<string>
  ? string
  : T extends readonly (infer U)[]
    ? readonly Unbrand<U>[]
    : T extends ReadonlyMap<infer K, infer V>
      ? ReadonlyMap<Unbrand<K>, Unbrand<V>>
      : T extends ReadonlySet<infer U>
        ? ReadonlySet<Unbrand<U>>
        : T extends Date
          ? T
          : T extends (...args: infer A) => infer R
            ? (...args: { [I in keyof A]: Unbrand<A[I]> }) => Unbrand<R>
            : T extends object
              ? { readonly [K in keyof T]: Unbrand<T[K]> }
              : T;

export type Promisified<T> = T extends (
  ...args: infer A
) => Effect.Effect<infer R, infer _E>
  ? (...args: { [I in keyof A]: Unbrand<A[I]> }) => Promise<R>
  : T extends readonly unknown[]
    ? T
    : T extends object
      ? { readonly [K in keyof T]: Promisified<T[K]> }
      : T;

export type Executor<TPlugins extends readonly AnyPlugin[] = []> = Promisified<
  EffectExecutor<TPlugins>
>;

export interface ExecutorConfig<TPlugins extends readonly AnyPlugin[] = []> {
  /**
   * Precedence-ordered scope stack (innermost first). Optional — defaults
   * to a single-element stack with id "default-scope". Pass an array of
   * `{ id, name }` partials to build a multi-scope executor.
   */
  readonly scopes?: readonly { readonly id?: string; readonly name?: string }[];
  readonly plugins?: TPlugins;
  /**
   * How to respond when a tool requests user input mid-invocation. Pass
   * `"accept-all"` for tests / non-interactive hosts, or a handler
   * `(ctx) => Promise<ElicitationResponse>` for interactive ones.
   * Required at construction so per-invoke calls don't have to thread
   * an options arg.
   */
  readonly onElicitation: OnElicitation;
}

// ---------------------------------------------------------------------------
// Promisify proxy — walks nested objects, converts Effect-returning methods
// into Promise-returning methods. Non-Effect return values pass through.
// ---------------------------------------------------------------------------

const isPlainObject = (v: unknown): v is Record<string | symbol, unknown> =>
  v !== null &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  !(v instanceof Date) &&
  !(v instanceof Promise);

const promisifyDeep = <T>(value: T): Promisified<T> => {
  if (typeof value === "function") {
    return ((...args: unknown[]) => {
      const result = (value as (...a: unknown[]) => unknown).apply(
        undefined,
        args,
      );
      if (Effect.isEffect(result)) {
        return Effect.runPromise(result as Effect.Effect<unknown, unknown>);
      }
      return result;
    }) as Promisified<T>;
  }

  if (!isPlainObject(value)) return value as Promisified<T>;

  return new Proxy(value, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v === "function") {
        return (...args: unknown[]) => {
          const result = (v as (...a: unknown[]) => unknown).apply(
            target,
            args,
          );
          if (Effect.isEffect(result)) {
            return Effect.runPromise(result as Effect.Effect<unknown, unknown>);
          }
          return result;
        };
      }
      if (isPlainObject(v)) return promisifyDeep(v);
      return v;
    },
  }) as Promisified<T>;
};

// ---------------------------------------------------------------------------
// createExecutor — Promise wrapper over the Effect createExecutor.
// Defaults to an in-memory adapter + blob store, so a consumer can
// construct an executor with just `{ plugins: [...] }`.
// ---------------------------------------------------------------------------

export const createExecutor = async <
  const TPlugins extends readonly AnyPlugin[] = [],
>(
  config: ExecutorConfig<TPlugins>,
): Promise<Executor<TPlugins>> => {
  const plugins = (config.plugins ?? []) as unknown as TPlugins;
  const schema = collectSchemas(plugins);

  const scopes =
    config.scopes && config.scopes.length > 0
      ? config.scopes.map(
          (s, i) =>
            new Scope({
              id: ScopeId.make(s.id ?? (i === 0 ? "default-scope" : `scope-${i}`)),
              name: s.name ?? (i === 0 ? "default" : `scope-${i}`),
              createdAt: new Date(),
            }),
        )
      : [
          new Scope({
            id: ScopeId.make("default-scope"),
            name: "default",
            createdAt: new Date(),
          }),
        ];

  const effectConfig = {
    scopes,
    adapter: makeMemoryAdapter({ schema }),
    blobs: makeInMemoryBlobStore(),
    plugins,
    onElicitation: config.onElicitation,
  };

  // The SDK has no observability requirement; storage failures surface
  // as raw `StorageError` / `UniqueViolationError` in the typed channel.
  // `Effect.runPromise` turns them into Promise rejections — consumers
  // get the tagged error as the rejected value. See
  // notes/promise-sdk-typed-errors.md for the planned `runPromiseExit`
  // rewrite that exposes the full error union to consumers.
  const effectExecutor = await Effect.runPromise(
    createEffectExecutor(effectConfig),
  );

  return promisifyDeep(effectExecutor) as Executor<TPlugins>;
};
