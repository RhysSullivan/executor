import * as Effect from "effect/Effect";

import {
  createExecutorEffect,
  type CreateExecutorEffectOptions,
  type ExecutorEffect,
  type ExecutorSourceInput,
  type ExecutorSourceOAuthInput,
} from "./executor-effect";

type Promiseify<T> = T extends Effect.Effect<infer A, any, any>
  ? Promise<A>
  : T extends (...args: infer Args) => infer Result
    ? (...args: Args) => Promiseify<Result>
    : T extends Promise<infer A>
      ? Promise<A>
      : T extends object
        ? { [Key in keyof T]: Promiseify<T[Key]> }
        : T;

export type Executor = Omit<Promiseify<ExecutorEffect>, "runtime">;
export type CreateExecutorOptions = CreateExecutorEffectOptions;
export type {
  ExecutorSourceInput,
  ExecutorSourceOAuthInput,
};

const toPromiseExecutor = (executor: ExecutorEffect): Executor => {
  const run = <A, E>(effect: Effect.Effect<A, E, never>) =>
    Effect.runPromise(effect);

  return {
    installation: executor.installation,
    scopeId: executor.scopeId,
    actorScopeId: executor.actorScopeId,
    resolutionScopeIds: executor.resolutionScopeIds,
    close: () => executor.close(),
    local: {
      installation: () => run(executor.local.installation()),
      config: () => run(executor.local.config()),
      credentials: {
        get: (input) => run(executor.local.credentials.get(input)),
        submit: (input) => run(executor.local.credentials.submit(input)),
        complete: (input) => run(executor.local.credentials.complete(input)),
      },
    },
    secrets: {
      list: () => run(executor.secrets.list()),
      create: (payload) => run(executor.secrets.create(payload)),
      update: (input) => run(executor.secrets.update(input)),
      remove: (secretId) => run(executor.secrets.remove(secretId)),
    },
    policies: {
      list: () => run(executor.policies.list()),
      create: (payload) => run(executor.policies.create(payload)),
      get: (policyId) => run(executor.policies.get(policyId)),
      update: (policyId, payload) =>
        run(executor.policies.update(policyId, payload)),
      remove: (policyId) => run(executor.policies.remove(policyId)),
    },
    sources: {
      add: (input, options) => run(executor.sources.add(input, options)),
      discover: (input) => run(executor.sources.discover(input)),
      list: () => run(executor.sources.list()),
      create: (payload) => run(executor.sources.create(payload)),
      get: (sourceId) => run(executor.sources.get(sourceId)),
      update: (sourceId, payload) =>
        run(executor.sources.update(sourceId, payload)),
      remove: (sourceId) => run(executor.sources.remove(sourceId)),
      inspection: {
        get: (sourceId) => run(executor.sources.inspection.get(sourceId)),
        tool: (input) => run(executor.sources.inspection.tool(input)),
        discover: (input) => run(executor.sources.inspection.discover(input)),
      },
      oauthClients: {
        list: (providerKey) =>
          run(executor.sources.oauthClients.list(providerKey)),
        create: (payload) => run(executor.sources.oauthClients.create(payload)),
        remove: (oauthClientId) =>
          run(executor.sources.oauthClients.remove(oauthClientId)),
      },
      providerGrants: {
        remove: (grantId) =>
          run(executor.sources.providerGrants.remove(grantId)),
      },
    },
    oauth: {
      startSourceAuth: (input) => run(executor.oauth.startSourceAuth(input)),
      completeSourceAuth: (input) =>
        run(executor.oauth.completeSourceAuth(input)),
      completeProviderCallback: (input) =>
        run(executor.oauth.completeProviderCallback(input)),
    },
    executions: {
      create: (payload) => run(executor.executions.create(payload)),
      get: (executionId) => run(executor.executions.get(executionId)),
      resume: (executionId, payload) =>
        run(executor.executions.resume(executionId, payload)),
    },
  };
};

export const createExecutor = async (
  options: CreateExecutorOptions,
): Promise<Executor> => toPromiseExecutor(await Effect.runPromise(createExecutorEffect(options)));
