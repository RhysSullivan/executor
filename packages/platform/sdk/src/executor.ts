import * as Effect from "effect/Effect";

import type {
  AccountId,
  Execution,
  ExecutionEnvelope,
  ExecutionInteraction,
  LocalInstallation,
  LocalWorkspacePolicy,
  ProviderAuthGrant,
  Source,
  WorkspaceId,
  WorkspaceOauthClient,
} from "./schema";
import { ExecutionIdSchema } from "./schema";
import type { CreateExecutionPayload, ResumeExecutionPayload } from "./executions/contracts";
import type {
  CreateSecretPayload,
  CreateSecretResult,
  DeleteSecretResult,
  InstanceConfig,
  SecretListItem,
  UpdateSecretPayload,
  UpdateSecretResult,
} from "./local/contracts";
import {
  completeSourceCredentialSetup,
  getLocalInstallation,
  getSourceCredentialInteraction,
  submitSourceCredentialInteraction,
} from "./local/operations";
import {
  createLocalSecret,
  deleteLocalSecret,
  getLocalInstanceConfig,
  listLocalSecrets,
  updateLocalSecret,
} from "./local/secrets";
import type { CreatePolicyPayload, UpdatePolicyPayload } from "./policies/contracts";
import {
  createPolicy,
  getPolicy,
  listPolicies,
  removePolicy,
  updatePolicy,
} from "./policies/operations";
import type {
  CreateSourcePayload,
  CreateWorkspaceOauthClientPayload,
  UpdateSourcePayload,
} from "./sources/contracts";
import { discoverSource } from "./sources/discovery";
import {
  discoverSourceInspectionTools,
  getSourceInspection,
  getSourceInspectionToolDetail,
} from "./sources/inspection";
import {
  createSource,
  getSource,
  listSources,
  removeSource,
  updateSource,
} from "./sources/operations";
import type { ExecutorBackend } from "./backend";
import {
  provideExecutorRuntime,
  type ExecutorRuntime,
  type ExecutorRuntimeOptions,
  type CreateWorkspaceInternalToolMap,
  type ResolveExecutionEnvironment,
  type ResolveSecretMaterial,
  RuntimeSourceAuthServiceTag,
} from "./runtime";
import { createExecution, getExecution, resumeExecution } from "./runtime/execution/service";
import type {
  CompleteProviderOauthCallbackResult,
  CompleteSourceCredentialSetupResult,
  CompleteSourceOAuthSessionResult,
  ConnectGoogleDiscoveryBatchInput,
  ConnectGoogleDiscoveryBatchResult,
  ConnectMcpSourceInput,
  ExecutorAddSourceInput,
  ExecutorSourceAddResult,
  McpSourceConnectResult,
  StartSourceOAuthSessionInput,
  StartSourceOAuthSessionResult,
} from "./runtime/sources/source-auth-service";

type DistributiveOmit<T, Keys extends PropertyKey> = T extends unknown ? Omit<T, Keys> : never;
type ProvidedEffect<T extends Effect.Effect<any, any, any>> = Effect.Effect<
  Effect.Effect.Success<T>,
  Effect.Effect.Error<T>,
  never
>;

export type ExecutorSourceInput = DistributiveOmit<
  ExecutorAddSourceInput,
  "workspaceId" | "actorAccountId" | "executionId" | "interactionId"
>;

export type ExecutorSourceBatchInput = DistributiveOmit<
  ConnectGoogleDiscoveryBatchInput,
  "workspaceId" | "actorAccountId" | "executionId" | "interactionId"
>;

export type ExecutorMcpSourceInput = DistributiveOmit<
  ConnectMcpSourceInput,
  "workspaceId" | "actorAccountId"
>;

export type ExecutorSourceOAuthInput = DistributiveOmit<
  StartSourceOAuthSessionInput,
  "workspaceId" | "actorAccountId"
>;

export type Executor = {
  runtime: ExecutorRuntime;
  installation: LocalInstallation;
  workspaceId: WorkspaceId;
  accountId: AccountId;
  provide: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, any>;
  run: <A, E, R>(effect: Effect.Effect<A, E, R>) => Promise<A>;
  close: () => Promise<void>;
  effect: {
    local: {
      installation: () => ProvidedEffect<ReturnType<typeof getLocalInstallation>>;
      config: () => ProvidedEffect<ReturnType<typeof getLocalInstanceConfig>>;
      credentials: {
        get: (input: {
          sourceId: Source["id"];
          interactionId: ExecutionInteraction["id"];
        }) => ProvidedEffect<ReturnType<typeof getSourceCredentialInteraction>>;
        submit: (input: {
          sourceId: Source["id"];
          interactionId: ExecutionInteraction["id"];
          action: "submit" | "continue" | "cancel";
          token?: string | null;
        }) => ProvidedEffect<ReturnType<typeof submitSourceCredentialInteraction>>;
        complete: (input: {
          sourceId: Source["id"];
          state: string;
          code?: string | null;
          error?: string | null;
          errorDescription?: string | null;
        }) => ProvidedEffect<ReturnType<typeof completeSourceCredentialSetup>>;
      };
    };
    secrets: {
      list: () => ProvidedEffect<ReturnType<typeof listLocalSecrets>>;
      create: (payload: CreateSecretPayload) => ProvidedEffect<ReturnType<typeof createLocalSecret>>;
      update: (input: {
        secretId: string;
        payload: UpdateSecretPayload;
      }) => ProvidedEffect<ReturnType<typeof updateLocalSecret>>;
      remove: (secretId: string) => ProvidedEffect<ReturnType<typeof deleteLocalSecret>>;
    };
    policies: {
      list: () => ProvidedEffect<ReturnType<typeof listPolicies>>;
      create: (payload: CreatePolicyPayload) => ProvidedEffect<ReturnType<typeof createPolicy>>;
      get: (policyId: string) => ProvidedEffect<ReturnType<typeof getPolicy>>;
      update: (
        policyId: string,
        payload: UpdatePolicyPayload,
      ) => ProvidedEffect<ReturnType<typeof updatePolicy>>;
      remove: (policyId: string) => ProvidedEffect<ReturnType<typeof removePolicy>>;
    };
    sources: {
      add: (
        input: ExecutorSourceInput,
        options?: {
          baseUrl?: string | null;
        },
      ) => Effect.Effect<ExecutorSourceAddResult, Error, never>;
      connect: (payload: ExecutorMcpSourceInput) => Effect.Effect<McpSourceConnectResult, Error, never>;
      connectBatch: (
        payload: ExecutorSourceBatchInput,
      ) => Effect.Effect<ConnectGoogleDiscoveryBatchResult, Error, never>;
      discover: (input: {
        url: string;
        probeAuth?: Parameters<typeof discoverSource>[0]["probeAuth"];
      }) => ProvidedEffect<ReturnType<typeof discoverSource>>;
      list: () => ProvidedEffect<ReturnType<typeof listSources>>;
      create: (payload: CreateSourcePayload) => ProvidedEffect<ReturnType<typeof createSource>>;
      get: (sourceId: Source["id"]) => ProvidedEffect<ReturnType<typeof getSource>>;
      update: (
        sourceId: Source["id"],
        payload: UpdateSourcePayload,
      ) => ProvidedEffect<ReturnType<typeof updateSource>>;
      remove: (sourceId: Source["id"]) => ProvidedEffect<ReturnType<typeof removeSource>>;
      inspection: {
        get: (sourceId: Source["id"]) => ProvidedEffect<ReturnType<typeof getSourceInspection>>;
        tool: (input: {
          sourceId: Source["id"];
          toolPath: string;
        }) => ProvidedEffect<ReturnType<typeof getSourceInspectionToolDetail>>;
        discover: (input: {
          sourceId: Source["id"];
          payload: Parameters<typeof discoverSourceInspectionTools>[0]["payload"];
        }) => ProvidedEffect<ReturnType<typeof discoverSourceInspectionTools>>;
      };
      oauthClients: {
        list: (
          providerKey: string,
        ) => Effect.Effect<ReadonlyArray<WorkspaceOauthClient>, Error, never>;
        create: (
          payload: CreateWorkspaceOauthClientPayload,
        ) => Effect.Effect<WorkspaceOauthClient, Error, never>;
        remove: (
          oauthClientId: WorkspaceOauthClient["id"],
        ) => Effect.Effect<boolean, Error, never>;
      };
      providerGrants: {
        remove: (grantId: ProviderAuthGrant["id"]) => Effect.Effect<boolean, Error, never>;
      };
    };
    oauth: {
      startSourceAuth: (
        input: ExecutorSourceOAuthInput,
      ) => Effect.Effect<StartSourceOAuthSessionResult, Error, never>;
      completeSourceAuth: (input: {
        state: string;
        code?: string | null;
        error?: string | null;
        errorDescription?: string | null;
      }) => Effect.Effect<CompleteSourceOAuthSessionResult, Error, never>;
      completeProviderCallback: (input: {
        workspaceId?: WorkspaceId;
        actorAccountId?: AccountId | null;
        state: string;
        code?: string | null;
        error?: string | null;
        errorDescription?: string | null;
      }) => Effect.Effect<CompleteProviderOauthCallbackResult, Error, never>;
    };
    executions: {
      create: (payload: CreateExecutionPayload) => ProvidedEffect<ReturnType<typeof createExecution>>;
      get: (executionId: Execution["id"]) => ProvidedEffect<ReturnType<typeof getExecution>>;
      resume: (
        executionId: Execution["id"],
        payload: ResumeExecutionPayload,
      ) => ProvidedEffect<ReturnType<typeof resumeExecution>>;
    };
  };
  local: {
    installation: () => Promise<LocalInstallation>;
    config: () => Promise<InstanceConfig>;
    credentials: {
      get: (input: {
        sourceId: Source["id"];
        interactionId: ExecutionInteraction["id"];
      }) => Promise<Effect.Effect.Success<ReturnType<typeof getSourceCredentialInteraction>>>;
      submit: (input: {
        sourceId: Source["id"];
        interactionId: ExecutionInteraction["id"];
        action: "submit" | "continue" | "cancel";
        token?: string | null;
      }) => Promise<Effect.Effect.Success<ReturnType<typeof submitSourceCredentialInteraction>>>;
      complete: (input: {
        sourceId: Source["id"];
        state: string;
        code?: string | null;
        error?: string | null;
        errorDescription?: string | null;
      }) => Promise<CompleteSourceCredentialSetupResult>;
    };
  };
  secrets: {
    list: () => Promise<ReadonlyArray<SecretListItem>>;
    create: (payload: CreateSecretPayload) => Promise<CreateSecretResult>;
    update: (input: {
      secretId: string;
      payload: UpdateSecretPayload;
    }) => Promise<UpdateSecretResult>;
    remove: (secretId: string) => Promise<DeleteSecretResult>;
  };
  policies: {
    list: () => Promise<ReadonlyArray<LocalWorkspacePolicy>>;
    create: (payload: CreatePolicyPayload) => Promise<LocalWorkspacePolicy>;
    get: (policyId: string) => Promise<LocalWorkspacePolicy>;
    update: (
      policyId: string,
      payload: UpdatePolicyPayload,
    ) => Promise<LocalWorkspacePolicy>;
    remove: (policyId: string) => Promise<boolean>;
  };
  sources: {
    add: (
      input: ExecutorSourceInput,
      options?: {
        baseUrl?: string | null;
      },
    ) => Promise<ExecutorSourceAddResult>;
    connect: (payload: ExecutorMcpSourceInput) => Promise<McpSourceConnectResult>;
    connectBatch: (payload: ExecutorSourceBatchInput) => Promise<ConnectGoogleDiscoveryBatchResult>;
    discover: (input: {
      url: string;
      probeAuth?: Parameters<typeof discoverSource>[0]["probeAuth"];
    }) => Promise<Effect.Effect.Success<ReturnType<typeof discoverSource>>>;
    list: () => Promise<ReadonlyArray<Source>>;
    create: (payload: CreateSourcePayload) => Promise<Source>;
    get: (sourceId: Source["id"]) => Promise<Source>;
    update: (sourceId: Source["id"], payload: UpdateSourcePayload) => Promise<Source>;
    remove: (sourceId: Source["id"]) => Promise<boolean>;
    inspection: {
      get: (sourceId: Source["id"]) => Promise<Effect.Effect.Success<ReturnType<typeof getSourceInspection>>>;
      tool: (input: {
        sourceId: Source["id"];
        toolPath: string;
      }) => Promise<Effect.Effect.Success<ReturnType<typeof getSourceInspectionToolDetail>>>;
      discover: (input: {
        sourceId: Source["id"];
        payload: Parameters<typeof discoverSourceInspectionTools>[0]["payload"];
      }) => Promise<Effect.Effect.Success<ReturnType<typeof discoverSourceInspectionTools>>>;
    };
    oauthClients: {
      list: (providerKey: string) => Promise<ReadonlyArray<WorkspaceOauthClient>>;
      create: (
        payload: CreateWorkspaceOauthClientPayload,
      ) => Promise<WorkspaceOauthClient>;
      remove: (oauthClientId: WorkspaceOauthClient["id"]) => Promise<boolean>;
    };
    providerGrants: {
      remove: (grantId: ProviderAuthGrant["id"]) => Promise<boolean>;
    };
  };
  oauth: {
    startSourceAuth: (input: ExecutorSourceOAuthInput) => Promise<StartSourceOAuthSessionResult>;
    completeSourceAuth: (input: {
      state: string;
      code?: string | null;
      error?: string | null;
      errorDescription?: string | null;
    }) => Promise<CompleteSourceOAuthSessionResult>;
    completeProviderCallback: (input: {
      workspaceId?: WorkspaceId;
      actorAccountId?: AccountId | null;
      state: string;
      code?: string | null;
      error?: string | null;
      errorDescription?: string | null;
    }) => Promise<CompleteProviderOauthCallbackResult>;
  };
  executions: {
    create: (payload: CreateExecutionPayload) => Promise<ExecutionEnvelope>;
    get: (executionId: Execution["id"]) => Promise<ExecutionEnvelope>;
    resume: (
      executionId: Execution["id"],
      payload: ResumeExecutionPayload,
    ) => Promise<ExecutionEnvelope>;
  };
};

export type CreateExecutorOptions = ExecutorRuntimeOptions & {
  backend: ExecutorBackend;
};

const fromRuntime = (runtime: ExecutorRuntime): Executor => {
  const installation = runtime.localInstallation;
  const workspaceId = installation.workspaceId;
  const accountId = installation.accountId;
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    provideExecutorRuntime(effect, runtime);
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.runPromise(provide(effect) as Effect.Effect<A, E, never>);
  const provideSourceAuth = <A, E>(
    execute: (
      service: Effect.Effect.Success<typeof RuntimeSourceAuthServiceTag>,
    ) => Effect.Effect<A, E, any>,
  ) => provide(Effect.flatMap(RuntimeSourceAuthServiceTag, execute));
  const createSdkSourceSession = () => {
    const id = crypto.randomUUID();
    return {
      executionId: ExecutionIdSchema.make(`exec_sdk_${id}`),
      interactionId: `executor.sdk.${id}` as never,
    };
  };
  const effect = {
    local: {
      installation: () => provide(getLocalInstallation()),
      config: () => provide(getLocalInstanceConfig()),
      credentials: {
        get: ({ sourceId, interactionId }) =>
          provide(
            getSourceCredentialInteraction({
              workspaceId,
              sourceId,
              interactionId,
            }),
          ),
        submit: ({ sourceId, interactionId, action, token }) =>
          provide(
            submitSourceCredentialInteraction({
              workspaceId,
              sourceId,
              interactionId,
              action,
              token,
            }),
          ),
        complete: ({ sourceId, state, code, error, errorDescription }) =>
          provide(
            completeSourceCredentialSetup({
              workspaceId,
              sourceId,
              state,
              code,
              error,
              errorDescription,
            }),
          ),
      },
    },
    secrets: {
      list: () => provide(listLocalSecrets()),
      create: (payload: CreateSecretPayload) => provide(createLocalSecret(payload)),
      update: (input: { secretId: string; payload: UpdateSecretPayload }) =>
        provide(updateLocalSecret(input)),
      remove: (secretId: string) => provide(deleteLocalSecret(secretId)),
    },
    policies: {
      list: () => provide(listPolicies(workspaceId)),
      create: (payload: CreatePolicyPayload) =>
        provide(createPolicy({ workspaceId, payload })),
      get: (policyId: string) =>
        provide(getPolicy({ workspaceId, policyId: policyId as never })),
      update: (policyId: string, payload: UpdatePolicyPayload) =>
        provide(updatePolicy({ workspaceId, policyId: policyId as never, payload })),
      remove: (policyId: string) =>
        provide(removePolicy({ workspaceId, policyId: policyId as never })),
    },
    sources: {
      add: (input: ExecutorSourceInput, options?: { baseUrl?: string | null }) =>
        provideSourceAuth((service) => {
          const session = createSdkSourceSession();
          return service.addExecutorSource(
            {
              ...input,
              workspaceId,
              actorAccountId: accountId,
              executionId: session.executionId,
              interactionId: session.interactionId,
            },
            options,
          );
        }),
      connect: (payload: ExecutorMcpSourceInput) =>
        provideSourceAuth((service) =>
          service.connectMcpSource({
            ...payload,
            workspaceId,
            actorAccountId: accountId,
          }),
        ),
      connectBatch: (payload: ExecutorSourceBatchInput) =>
        provideSourceAuth((service) => {
          const session = createSdkSourceSession();
          return service.connectGoogleDiscoveryBatch({
            ...payload,
            workspaceId,
            actorAccountId: accountId,
            executionId: session.executionId,
            interactionId: session.interactionId,
          });
        }),
      discover: (input: {
        url: string;
        probeAuth?: Parameters<typeof discoverSource>[0]["probeAuth"];
      }) => provide(discoverSource(input)),
      list: () => provide(listSources({ workspaceId, accountId })),
      create: (payload: CreateSourcePayload) =>
        provide(createSource({ workspaceId, accountId, payload })),
      get: (sourceId: Source["id"]) =>
        provide(getSource({ workspaceId, sourceId, accountId })),
      update: (sourceId: Source["id"], payload: UpdateSourcePayload) =>
        provide(updateSource({ workspaceId, sourceId, accountId, payload })),
      remove: (sourceId: Source["id"]) =>
        provide(removeSource({ workspaceId, sourceId })),
      inspection: {
        get: (sourceId: Source["id"]) =>
          provide(getSourceInspection({ workspaceId, sourceId })),
        tool: ({ sourceId, toolPath }: { sourceId: Source["id"]; toolPath: string }) =>
          provide(
            getSourceInspectionToolDetail({
              workspaceId,
              sourceId,
              toolPath,
            }),
          ),
        discover: ({
          sourceId,
          payload,
        }: {
          sourceId: Source["id"];
          payload: Parameters<typeof discoverSourceInspectionTools>[0]["payload"];
        }) =>
          provide(
            discoverSourceInspectionTools({
              workspaceId,
              sourceId,
              payload,
            }),
          ),
      },
      oauthClients: {
        list: (providerKey: string) =>
          provideSourceAuth((service) =>
            service.listWorkspaceOauthClients({
              workspaceId,
              providerKey,
            }),
          ),
        create: (payload: CreateWorkspaceOauthClientPayload) =>
          provideSourceAuth((service) =>
            service.createWorkspaceOauthClient({
              workspaceId,
              providerKey: payload.providerKey,
              label: payload.label,
              oauthClient: payload.oauthClient,
            }),
          ),
        remove: (oauthClientId: WorkspaceOauthClient["id"]) =>
          provideSourceAuth((service) =>
            service.removeWorkspaceOauthClient({
              workspaceId,
              oauthClientId,
            }),
          ),
      },
      providerGrants: {
        remove: (grantId: ProviderAuthGrant["id"]) =>
          provideSourceAuth((service) =>
            service.removeProviderAuthGrant({
              workspaceId,
              grantId,
            }),
          ),
      },
    },
    oauth: {
      startSourceAuth: (input: ExecutorSourceOAuthInput) =>
        provideSourceAuth((service) =>
          service.startSourceOAuthSession({
            ...input,
            workspaceId,
            actorAccountId: accountId,
          }),
        ),
      completeSourceAuth: ({ state, code, error, errorDescription }) =>
        provideSourceAuth((service) =>
          service.completeSourceOAuthSession({
            state,
            code,
            error,
            errorDescription,
          }),
        ),
      completeProviderCallback: (input) =>
        provideSourceAuth((service) =>
          service.completeProviderOauthCallback({
            ...input,
            workspaceId: input.workspaceId ?? workspaceId,
            actorAccountId: input.actorAccountId ?? accountId,
          }),
        ),
    },
    executions: {
      create: (payload: CreateExecutionPayload) =>
        provide(
          createExecution({
            workspaceId,
            payload,
            createdByAccountId: accountId,
          }),
        ),
      get: (executionId: Execution["id"]) =>
        provide(getExecution({ workspaceId, executionId })),
      resume: (executionId: Execution["id"], payload: ResumeExecutionPayload) =>
        provide(
          resumeExecution({
            workspaceId,
            executionId,
            payload,
            resumedByAccountId: accountId,
          }),
        ),
    },
  } satisfies Executor["effect"];

  return {
    runtime,
    installation,
    workspaceId,
    accountId,
    provide,
    run,
    close: () => runtime.close(),
    effect,
    local: {
      installation: () => run(effect.local.installation()),
      config: () => run(effect.local.config()),
      credentials: {
        get: ({ sourceId, interactionId }) =>
          run(effect.local.credentials.get({ sourceId, interactionId })),
        submit: ({ sourceId, interactionId, action, token }) =>
          run(effect.local.credentials.submit({ sourceId, interactionId, action, token })),
        complete: ({ sourceId, state, code, error, errorDescription }) =>
          run(effect.local.credentials.complete({ sourceId, state, code, error, errorDescription })),
      },
    },
    secrets: {
      list: () => run(effect.secrets.list()),
      create: (payload) => run(effect.secrets.create(payload)),
      update: (input) => run(effect.secrets.update(input)),
      remove: (secretId) => run(effect.secrets.remove(secretId)),
    },
    policies: {
      list: () => run(effect.policies.list()),
      create: (payload) => run(effect.policies.create(payload)),
      get: (policyId) => run(effect.policies.get(policyId)),
      update: (policyId, payload) =>
        run(effect.policies.update(policyId, payload)),
      remove: async (policyId) =>
        (await run(effect.policies.remove(policyId))).removed,
    },
    sources: {
      add: (input, options) => run(effect.sources.add(input, options)),
      connect: (payload) => run(effect.sources.connect(payload)),
      connectBatch: (payload) => run(effect.sources.connectBatch(payload)),
      discover: (input) => run(effect.sources.discover(input)),
      list: () => run(effect.sources.list()),
      create: (payload) => run(effect.sources.create(payload)),
      get: (sourceId) => run(effect.sources.get(sourceId)),
      update: (sourceId, payload) =>
        run(effect.sources.update(sourceId, payload)),
      remove: async (sourceId) =>
        (await run(effect.sources.remove(sourceId))).removed,
      inspection: {
        get: (sourceId) => run(effect.sources.inspection.get(sourceId)),
        tool: ({ sourceId, toolPath }) =>
          run(effect.sources.inspection.tool({ sourceId, toolPath })),
        discover: ({ sourceId, payload }) =>
          run(effect.sources.inspection.discover({ sourceId, payload })),
      },
      oauthClients: {
        list: (providerKey) =>
          run(effect.sources.oauthClients.list(providerKey)),
        create: (payload) => run(effect.sources.oauthClients.create(payload)),
        remove: (oauthClientId) =>
          run(effect.sources.oauthClients.remove(oauthClientId)),
      },
      providerGrants: {
        remove: (grantId) =>
          run(effect.sources.providerGrants.remove(grantId)),
      },
    },
    oauth: {
      startSourceAuth: (input) => run(effect.oauth.startSourceAuth(input)),
      completeSourceAuth: ({ state, code, error, errorDescription }) =>
        run(effect.oauth.completeSourceAuth({ state, code, error, errorDescription })),
      completeProviderCallback: (input) =>
        run(effect.oauth.completeProviderCallback(input)),
    },
    executions: {
      create: (payload) => run(effect.executions.create(payload)),
      get: (executionId) => run(effect.executions.get(executionId)),
      resume: (executionId, payload) =>
        run(effect.executions.resume(executionId, payload)),
    },
  };
};

export const createExecutorEffect = (
  options: CreateExecutorOptions,
): Effect.Effect<Executor, Error> =>
  Effect.map(
    options.backend.createRuntime({
      executionResolver: options.executionResolver,
      createInternalToolMap: options.createInternalToolMap,
      resolveSecretMaterial: options.resolveSecretMaterial,
      getLocalServerBaseUrl: options.getLocalServerBaseUrl,
    }),
    fromRuntime,
  );

export const createExecutor = async (
  options: CreateExecutorOptions,
): Promise<Executor> => Effect.runPromise(createExecutorEffect(options));
