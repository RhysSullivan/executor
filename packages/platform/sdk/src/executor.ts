import * as Effect from "effect/Effect";

import {
  createExecutorEffect,
  type CreateExecutorEffectOptions,
  type ExecutorEffect,
} from "./executor-effect";
import type {
  ExecutorSdkPlugin,
  ExecutorSdkPluginExtensions,
} from "./plugins";

type Promiseify<T> = T extends Effect.Effect<infer A, any, any>
  ? Promise<A>
  : T extends (...args: infer Args) => infer Result
    ? (...args: Args) => Promiseify<Result>
    : T extends Promise<infer A>
      ? Promise<A>
      : T extends object
        ? { [Key in keyof T]: Promiseify<T[Key]> }
        : T;

export type Executor<
  TPlugins extends readonly ExecutorSdkPlugin<any, any>[] = [],
> = Omit<
  Promiseify<ExecutorEffect & ExecutorSdkPluginExtensions<TPlugins>>,
  "runtime"
>;
export type CreateExecutorOptions<
  TPlugins extends readonly ExecutorSdkPlugin<any, any>[] = [],
> = CreateExecutorEffectOptions & {
  plugins?: TPlugins;
};

const toPromiseExecutor = <
  TPlugins extends readonly ExecutorSdkPlugin<any, any>[],
>(
  executor: ExecutorEffect & ExecutorSdkPluginExtensions<TPlugins>,
): Executor<TPlugins> => {
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.runPromise(effect as Effect.Effect<A, E, never>);
  const promiseifyValue = (value: unknown): unknown => {
    if (Effect.isEffect(value)) {
      return run(value);
    }

    if (value instanceof Promise) {
      return value;
    }

    if (typeof value === "function") {
      return (...args: Array<unknown>) =>
        promiseifyValue(value(...args));
    }

    if (Array.isArray(value)) {
      return value.map(promiseifyValue);
    }

    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, nestedValue]) => [
          key,
          promiseifyValue(nestedValue),
        ]),
      );
    }

    return value;
  };

  const base = {
    scope: executor.scope,
    installation: executor.installation,
    scopeId: executor.scopeId,
    actorScopeId: executor.actorScopeId,
    resolutionScopeIds: executor.resolutionScopeIds,
    close: () => executor.close(),
    local: {
      installation: () => run(executor.local.installation()),
      config: () => run(executor.local.config()),
    },
    secrets: {
      list: () => run(executor.secrets.list()),
      create: (payload: Parameters<typeof executor.secrets.create>[0]) =>
        run(executor.secrets.create(payload)),
      update: (input: Parameters<typeof executor.secrets.update>[0]) =>
        run(executor.secrets.update(input)),
      remove: (secretId: Parameters<typeof executor.secrets.remove>[0]) =>
        run(executor.secrets.remove(secretId)),
    },
    policies: {
      list: () => run(executor.policies.list()),
      create: (payload: Parameters<typeof executor.policies.create>[0]) =>
        run(executor.policies.create(payload)),
      get: (policyId: Parameters<typeof executor.policies.get>[0]) =>
        run(executor.policies.get(policyId)),
      update: (
        policyId: Parameters<typeof executor.policies.update>[0],
        payload: Parameters<typeof executor.policies.update>[1],
      ) =>
        run(executor.policies.update(policyId, payload)),
      remove: (policyId: Parameters<typeof executor.policies.remove>[0]) =>
        run(executor.policies.remove(policyId)),
    },
    sources: {
      list: () => run(executor.sources.list()),
      get: (sourceId: Parameters<typeof executor.sources.get>[0]) =>
        run(executor.sources.get(sourceId)),
      remove: (sourceId: Parameters<typeof executor.sources.remove>[0]) =>
        run(executor.sources.remove(sourceId)),
      inspection: {
        get: (sourceId: Parameters<typeof executor.sources.inspection.get>[0]) =>
          run(executor.sources.inspection.get(sourceId)),
        tool: (input: Parameters<typeof executor.sources.inspection.tool>[0]) =>
          run(executor.sources.inspection.tool(input)),
        discover: (
          input: Parameters<typeof executor.sources.inspection.discover>[0],
        ) => run(executor.sources.inspection.discover(input)),
      },
    },
    executions: {
      list: () => run(executor.executions.list()),
      create: (payload: Parameters<typeof executor.executions.create>[0]) =>
        run(executor.executions.create(payload)),
      get: (executionId: Parameters<typeof executor.executions.get>[0]) =>
        run(executor.executions.get(executionId)),
      resume: (
        executionId: Parameters<typeof executor.executions.resume>[0],
        payload: Parameters<typeof executor.executions.resume>[1],
      ) =>
        run(executor.executions.resume(executionId, payload)),
    },
  };

  const coreKeys = new Set([
    "runtime",
    "installation",
    "scope",
    "scopeId",
    "actorScopeId",
    "resolutionScopeIds",
    "close",
    "local",
    "secrets",
    "policies",
    "sources",
    "executions",
  ]);

  const pluginExtensions = Object.fromEntries(
    Object.entries(executor)
      .filter(([key]) => !coreKeys.has(key))
      .map(([key, value]) => [key, promiseifyValue(value)]),
  );

  return Object.assign(base, pluginExtensions) as unknown as Executor<TPlugins>;
};

export const createExecutor = async <
  const TPlugins extends readonly ExecutorSdkPlugin<any, any>[] = [],
>(
  options: CreateExecutorOptions<TPlugins>,
): Promise<Executor<TPlugins>> =>
  toPromiseExecutor(
    await Effect.runPromise(createExecutorEffect(options)),
  );
