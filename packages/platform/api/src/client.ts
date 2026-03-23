import * as Effect from "effect/Effect";

import {
  createExecutorApiEffectClient,
  type ExecutorApiEffectClient,
} from "./effect";

type StripResponse<T> = T extends readonly [infer Value, unknown] ? Value : T;
type RemoveWithResponse<T> = T extends object ? Omit<T, "withResponse"> : T;
type MethodInput<F extends (input: any) => Effect.Effect<any, any, any>> = RemoveWithResponse<
  Parameters<F>[0]
>;
type MethodOutput<F extends (input: any) => Effect.Effect<any, any, any>> = StripResponse<
  Effect.Effect.Success<ReturnType<F>>
>;
type PromiseMethod<F extends (input: any) => Effect.Effect<any, any, any>> = (
  input: MethodInput<F>,
) => Promise<MethodOutput<F>>;

export type ExecutorApiClient = {
  local: {
    installation: PromiseMethod<ExecutorApiEffectClient["local"]["installation"]>;
    config: PromiseMethod<ExecutorApiEffectClient["local"]["config"]>;
    listSecrets: PromiseMethod<ExecutorApiEffectClient["local"]["listSecrets"]>;
    createSecret: PromiseMethod<ExecutorApiEffectClient["local"]["createSecret"]>;
    updateSecret: PromiseMethod<ExecutorApiEffectClient["local"]["updateSecret"]>;
    deleteSecret: PromiseMethod<ExecutorApiEffectClient["local"]["deleteSecret"]>;
  };
  policies: {
    list: PromiseMethod<ExecutorApiEffectClient["policies"]["list"]>;
    create: PromiseMethod<ExecutorApiEffectClient["policies"]["create"]>;
    get: PromiseMethod<ExecutorApiEffectClient["policies"]["get"]>;
    update: PromiseMethod<ExecutorApiEffectClient["policies"]["update"]>;
    remove: PromiseMethod<ExecutorApiEffectClient["policies"]["remove"]>;
  };
  sources: {
    discover: PromiseMethod<ExecutorApiEffectClient["sources"]["discover"]>;
    listWorkspaceOauthClients: PromiseMethod<
      ExecutorApiEffectClient["sources"]["listWorkspaceOauthClients"]
    >;
    createWorkspaceOauthClient: PromiseMethod<
      ExecutorApiEffectClient["sources"]["createWorkspaceOauthClient"]
    >;
    removeWorkspaceOauthClient: PromiseMethod<
      ExecutorApiEffectClient["sources"]["removeWorkspaceOauthClient"]
    >;
    removeProviderAuthGrant: PromiseMethod<
      ExecutorApiEffectClient["sources"]["removeProviderAuthGrant"]
    >;
    list: PromiseMethod<ExecutorApiEffectClient["sources"]["list"]>;
    create: PromiseMethod<ExecutorApiEffectClient["sources"]["create"]>;
    get: PromiseMethod<ExecutorApiEffectClient["sources"]["get"]>;
    update: PromiseMethod<ExecutorApiEffectClient["sources"]["update"]>;
    remove: PromiseMethod<ExecutorApiEffectClient["sources"]["remove"]>;
    inspection: PromiseMethod<ExecutorApiEffectClient["sources"]["inspection"]>;
    inspectionTool: PromiseMethod<ExecutorApiEffectClient["sources"]["inspectionTool"]>;
    inspectionDiscover: PromiseMethod<
      ExecutorApiEffectClient["sources"]["inspectionDiscover"]
    >;
    credentialPage: PromiseMethod<ExecutorApiEffectClient["sources"]["credentialPage"]>;
    credentialSubmit: PromiseMethod<ExecutorApiEffectClient["sources"]["credentialSubmit"]>;
    credentialComplete: PromiseMethod<
      ExecutorApiEffectClient["sources"]["credentialComplete"]
    >;
    providerOauthComplete: PromiseMethod<
      ExecutorApiEffectClient["sources"]["providerOauthComplete"]
    >;
  };
  oauth: {
    startSourceAuth: PromiseMethod<ExecutorApiEffectClient["oauth"]["startSourceAuth"]>;
    sourceAuthCallback: PromiseMethod<ExecutorApiEffectClient["oauth"]["sourceAuthCallback"]>;
  };
  executions: {
    create: PromiseMethod<ExecutorApiEffectClient["executions"]["create"]>;
    get: PromiseMethod<ExecutorApiEffectClient["executions"]["get"]>;
    resume: PromiseMethod<ExecutorApiEffectClient["executions"]["resume"]>;
  };
};

const isResponseTuple = <Value>(
  value: Value | readonly [Value, unknown],
): value is readonly [Value, unknown] =>
  Array.isArray(value) && value.length === 2;

function stripResponse<Value>(value: Value | readonly [Value, unknown]): Value {
  return isResponseTuple(value) ? value[0] : value;
}

const wrapMethod = <
  F extends (input: any) => Effect.Effect<any, unknown, never>,
>(
  effectClientPromise: Promise<ExecutorApiEffectClient>,
  select: (client: ExecutorApiEffectClient) => F,
): PromiseMethod<F> => {
  const wrapped = (input: MethodInput<F>): Promise<MethodOutput<F>> =>
    effectClientPromise
      .then((client) => Effect.runPromise(select(client)(input)))
      .then(stripResponse);

  return wrapped;
};

export const createExecutorApiClient = async (input: {
  baseUrl: string;
  accountId?: string;
}): Promise<ExecutorApiClient> => {
  const effectClientPromise = Effect.runPromise(
    createExecutorApiEffectClient(input),
  );

  return {
    local: {
      installation: wrapMethod(effectClientPromise, (client) => client.local.installation),
      config: wrapMethod(effectClientPromise, (client) => client.local.config),
      listSecrets: wrapMethod(effectClientPromise, (client) => client.local.listSecrets),
      createSecret: wrapMethod(effectClientPromise, (client) => client.local.createSecret),
      updateSecret: wrapMethod(effectClientPromise, (client) => client.local.updateSecret),
      deleteSecret: wrapMethod(effectClientPromise, (client) => client.local.deleteSecret),
    },
    policies: {
      list: wrapMethod(effectClientPromise, (client) => client.policies.list),
      create: wrapMethod(effectClientPromise, (client) => client.policies.create),
      get: wrapMethod(effectClientPromise, (client) => client.policies.get),
      update: wrapMethod(effectClientPromise, (client) => client.policies.update),
      remove: wrapMethod(effectClientPromise, (client) => client.policies.remove),
    },
    sources: {
      discover: wrapMethod(effectClientPromise, (client) => client.sources.discover),
      listWorkspaceOauthClients: wrapMethod(
        effectClientPromise,
        (client) => client.sources.listWorkspaceOauthClients,
      ),
      createWorkspaceOauthClient: wrapMethod(
        effectClientPromise,
        (client) => client.sources.createWorkspaceOauthClient,
      ),
      removeWorkspaceOauthClient: wrapMethod(
        effectClientPromise,
        (client) => client.sources.removeWorkspaceOauthClient,
      ),
      removeProviderAuthGrant: wrapMethod(
        effectClientPromise,
        (client) => client.sources.removeProviderAuthGrant,
      ),
      list: wrapMethod(effectClientPromise, (client) => client.sources.list),
      create: wrapMethod(effectClientPromise, (client) => client.sources.create),
      get: wrapMethod(effectClientPromise, (client) => client.sources.get),
      update: wrapMethod(effectClientPromise, (client) => client.sources.update),
      remove: wrapMethod(effectClientPromise, (client) => client.sources.remove),
      inspection: wrapMethod(effectClientPromise, (client) => client.sources.inspection),
      inspectionTool: wrapMethod(
        effectClientPromise,
        (client) => client.sources.inspectionTool,
      ),
      inspectionDiscover: wrapMethod(
        effectClientPromise,
        (client) => client.sources.inspectionDiscover,
      ),
      credentialPage: wrapMethod(
        effectClientPromise,
        (client) => client.sources.credentialPage,
      ),
      credentialSubmit: wrapMethod(
        effectClientPromise,
        (client) => client.sources.credentialSubmit,
      ),
      credentialComplete: wrapMethod(
        effectClientPromise,
        (client) => client.sources.credentialComplete,
      ),
      providerOauthComplete: wrapMethod(
        effectClientPromise,
        (client) => client.sources.providerOauthComplete,
      ),
    },
    oauth: {
      startSourceAuth: wrapMethod(
        effectClientPromise,
        (client) => client.oauth.startSourceAuth,
      ),
      sourceAuthCallback: wrapMethod(
        effectClientPromise,
        (client) => client.oauth.sourceAuthCallback,
      ),
    },
    executions: {
      create: wrapMethod(effectClientPromise, (client) => client.executions.create),
      get: wrapMethod(effectClientPromise, (client) => client.executions.get),
      resume: wrapMethod(effectClientPromise, (client) => client.executions.resume),
    },
  };
};
