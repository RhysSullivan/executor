import * as Effect from "effect/Effect";

import type {
  ScopeId,
  Execution,
  ExecutionEnvelope,
  ExecutionInteraction,
  LocalInstallation,
  LocalScopePolicy,
  ProviderAuthGrant,
  ScopeOauthClient,
  Source,
} from "./schema";
import { ExecutionIdSchema } from "./schema";
import type {
  CreateExecutionPayload,
  ResumeExecutionPayload,
} from "./executions/contracts";
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
import type {
  CreatePolicyPayload,
  UpdatePolicyPayload,
} from "./policies/contracts";
import {
  createPolicy,
  getPolicy,
  listPolicies,
  removePolicy,
  updatePolicy,
} from "./policies/operations";
import type {
  CreateScopeOauthClientPayload,
  CreateSourcePayload,
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
  type CreateScopeInternalToolMap,
  type ExecutorRuntime,
  type ExecutorRuntimeOptions,
  type ResolveExecutionEnvironment,
  type ResolveSecretMaterial,
  RuntimeSourceAuthServiceTag,
} from "./runtime";
import {
  createExecution,
  getExecution,
  resumeExecution,
} from "./runtime/execution/service";
import type {
  CompleteProviderOauthCallbackResult,
  CompleteSourceCredentialSetupResult,
  CompleteSourceOAuthSessionResult,
  ExecutorAddSourceInput,
  ExecutorSourceAddResult,
  StartSourceOAuthSessionInput,
  StartSourceOAuthSessionResult,
} from "./runtime/sources/source-auth-service";

type DistributiveOmit<T, Keys extends PropertyKey> = T extends unknown
  ? Omit<T, Keys>
  : never;
type ProvidedEffect<T extends Effect.Effect<any, any, any>> = Effect.Effect<
  Effect.Effect.Success<T>,
  Effect.Effect.Error<T>,
  never
>;
type MappedProvidedEffect<
  T extends Effect.Effect<any, any, any>,
  A,
> = Effect.Effect<A, Effect.Effect.Error<T>, never>;

export type ExecutorSourceInput = DistributiveOmit<
  ExecutorAddSourceInput,
  "scopeId" | "actorScopeId" | "executionId" | "interactionId"
>;

export type ExecutorSourceOAuthInput = DistributiveOmit<
  StartSourceOAuthSessionInput,
  "scopeId" | "actorScopeId"
>;

export type ExecutorEffect = {
  runtime: ExecutorRuntime;
  installation: LocalInstallation;
  scopeId: ScopeId;
  actorScopeId: ScopeId;
  resolutionScopeIds: ReadonlyArray<ScopeId>;
  close: () => Promise<void>;
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
      }) => ProvidedEffect<
        ReturnType<typeof submitSourceCredentialInteraction>
      >;
      complete: (input: {
        sourceId: Source["id"];
        state: string;
        code?: string | null;
        error?: string | null;
        errorDescription?: string | null;
      }) => MappedProvidedEffect<
        ReturnType<typeof completeSourceCredentialSetup>,
        CompleteSourceCredentialSetupResult
      >;
    };
  };
  secrets: {
    list: () => ProvidedEffect<ReturnType<typeof listLocalSecrets>>;
    create: (
      payload: CreateSecretPayload,
    ) => ProvidedEffect<ReturnType<typeof createLocalSecret>>;
    update: (input: {
      secretId: string;
      payload: UpdateSecretPayload;
    }) => ProvidedEffect<ReturnType<typeof updateLocalSecret>>;
    remove: (
      secretId: string,
    ) => MappedProvidedEffect<
      ReturnType<typeof deleteLocalSecret>,
      DeleteSecretResult
    >;
  };
  policies: {
    list: () => ProvidedEffect<ReturnType<typeof listPolicies>>;
    create: (
      payload: CreatePolicyPayload,
    ) => ProvidedEffect<ReturnType<typeof createPolicy>>;
    get: (policyId: string) => ProvidedEffect<ReturnType<typeof getPolicy>>;
    update: (
      policyId: string,
      payload: UpdatePolicyPayload,
    ) => ProvidedEffect<ReturnType<typeof updatePolicy>>;
    remove: (
      policyId: string,
    ) => MappedProvidedEffect<ReturnType<typeof removePolicy>, boolean>;
  };
  sources: {
    add: (
      input: ExecutorSourceInput,
      options?: {
        baseUrl?: string | null;
      },
    ) => Effect.Effect<ExecutorSourceAddResult, Error, never>;
    discover: (input: {
      url: string;
      probeAuth?: Parameters<typeof discoverSource>[0]["probeAuth"];
    }) => ProvidedEffect<ReturnType<typeof discoverSource>>;
    list: () => ProvidedEffect<ReturnType<typeof listSources>>;
    create: (
      payload: CreateSourcePayload,
    ) => ProvidedEffect<ReturnType<typeof createSource>>;
    get: (sourceId: Source["id"]) => ProvidedEffect<ReturnType<typeof getSource>>;
    update: (
      sourceId: Source["id"],
      payload: UpdateSourcePayload,
    ) => ProvidedEffect<ReturnType<typeof updateSource>>;
    remove: (
      sourceId: Source["id"],
    ) => MappedProvidedEffect<ReturnType<typeof removeSource>, boolean>;
    inspection: {
      get: (
        sourceId: Source["id"],
      ) => ProvidedEffect<ReturnType<typeof getSourceInspection>>;
      tool: (input: {
        sourceId: Source["id"];
        toolPath: string;
      }) => ProvidedEffect<ReturnType<typeof getSourceInspectionToolDetail>>;
      discover: (input: {
        sourceId: Source["id"];
        payload: Parameters<typeof discoverSourceInspectionTools>[0]["payload"];
      }) => ProvidedEffect<
        ReturnType<typeof discoverSourceInspectionTools>
      >;
    };
    oauthClients: {
      list: (
        providerKey: string,
      ) => Effect.Effect<ReadonlyArray<ScopeOauthClient>, Error, never>;
      create: (
        payload: CreateScopeOauthClientPayload,
      ) => Effect.Effect<ScopeOauthClient, Error, never>;
      remove: (
        oauthClientId: ScopeOauthClient["id"],
      ) => Effect.Effect<boolean, Error, never>;
    };
    providerGrants: {
      remove: (
        grantId: ProviderAuthGrant["id"],
      ) => Effect.Effect<boolean, Error, never>;
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
      scopeId?: ScopeId;
      actorScopeId?: ScopeId | null;
      state: string;
      code?: string | null;
      error?: string | null;
      errorDescription?: string | null;
    }) => Effect.Effect<CompleteProviderOauthCallbackResult, Error, never>;
  };
  executions: {
    create: (
      payload: CreateExecutionPayload,
    ) => ProvidedEffect<ReturnType<typeof createExecution>>;
    get: (
      executionId: Execution["id"],
    ) => ProvidedEffect<ReturnType<typeof getExecution>>;
    resume: (
      executionId: Execution["id"],
      payload: ResumeExecutionPayload,
    ) => ProvidedEffect<ReturnType<typeof resumeExecution>>;
  };
};

export type CreateExecutorEffectOptions = ExecutorRuntimeOptions & {
  backend: ExecutorBackend;
};

const fromRuntime = (runtime: ExecutorRuntime): ExecutorEffect => {
  const installation = runtime.localInstallation;
  const scopeId = installation.scopeId;
  const actorScopeId = installation.actorScopeId;
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    provideExecutorRuntime(effect, runtime);
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

  return {
    runtime,
    installation,
    scopeId,
    actorScopeId,
    resolutionScopeIds: installation.resolutionScopeIds,
    close: () => runtime.close(),
    local: {
      installation: () => provide(getLocalInstallation()),
      config: () => provide(getLocalInstanceConfig()),
      credentials: {
        get: ({ sourceId, interactionId }) =>
          provide(
            getSourceCredentialInteraction({
              scopeId,
              sourceId,
              interactionId,
            }),
          ),
        submit: ({ sourceId, interactionId, action, token }) =>
          provide(
            submitSourceCredentialInteraction({
              scopeId,
              sourceId,
              interactionId,
              action,
              token,
            }),
          ),
        complete: ({ sourceId, state, code, error, errorDescription }) =>
          provide(
            completeSourceCredentialSetup({
              scopeId,
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
      create: (payload) => provide(createLocalSecret(payload)),
      update: (input) => provide(updateLocalSecret(input)),
      remove: (secretId) => provide(deleteLocalSecret(secretId)),
    },
    policies: {
      list: () => provide(listPolicies(scopeId)),
      create: (payload) => provide(createPolicy({ scopeId, payload })),
      get: (policyId) =>
        provide(getPolicy({ scopeId, policyId: policyId as never })),
      update: (policyId, payload) =>
        provide(updatePolicy({ scopeId, policyId: policyId as never, payload })),
      remove: (policyId) =>
        provide(removePolicy({ scopeId, policyId: policyId as never })).pipe(
          Effect.map((result) => result.removed),
        ),
    },
    sources: {
      add: (input, options) =>
        provideSourceAuth((service) => {
          const session = createSdkSourceSession();
          return service.addExecutorSource(
            {
              ...input,
              scopeId,
              actorScopeId,
              executionId: session.executionId,
              interactionId: session.interactionId,
            },
            options,
          );
        }),
      discover: (input) => provide(discoverSource(input)),
      list: () => provide(listSources({ scopeId, actorScopeId })),
      create: (payload) => provide(createSource({ scopeId, actorScopeId, payload })),
      get: (sourceId) => provide(getSource({ scopeId, sourceId, actorScopeId })),
      update: (sourceId, payload) =>
        provide(updateSource({ scopeId, sourceId, actorScopeId, payload })),
      remove: (sourceId) =>
        provide(removeSource({ scopeId, sourceId })).pipe(
          Effect.map((result) => result.removed),
        ),
      inspection: {
        get: (sourceId) => provide(getSourceInspection({ scopeId, sourceId })),
        tool: ({ sourceId, toolPath }) =>
          provide(
            getSourceInspectionToolDetail({
              scopeId,
              sourceId,
              toolPath,
            }),
          ),
        discover: ({ sourceId, payload }) =>
          provide(
            discoverSourceInspectionTools({
              scopeId,
              sourceId,
              payload,
            }),
          ),
      },
      oauthClients: {
        list: (providerKey) =>
          provideSourceAuth((service) =>
            service.listScopeOauthClients({
              scopeId,
              providerKey,
            }),
          ),
        create: (payload) =>
          provideSourceAuth((service) =>
            service.createScopeOauthClient({
              scopeId,
              providerKey: payload.providerKey,
              label: payload.label,
              oauthClient: payload.oauthClient,
            }),
          ),
        remove: (oauthClientId) =>
          provideSourceAuth((service) =>
            service.removeScopeOauthClient({
              scopeId,
              oauthClientId,
            }),
          ),
      },
      providerGrants: {
        remove: (grantId) =>
          provideSourceAuth((service) =>
            service.removeProviderAuthGrant({
              scopeId,
              grantId,
            }),
          ),
      },
    },
    oauth: {
      startSourceAuth: (input) =>
        provideSourceAuth((service) =>
          service.startSourceOAuthSession({
            ...input,
            scopeId,
            actorScopeId,
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
            scopeId: input.scopeId ?? scopeId,
            actorScopeId: input.actorScopeId ?? actorScopeId,
          }),
        ),
    },
    executions: {
      create: (payload) =>
        provide(
          createExecution({
            scopeId,
            payload,
            createdByScopeId: actorScopeId,
          }),
        ),
      get: (executionId) => provide(getExecution({ scopeId, executionId })),
      resume: (executionId, payload) =>
        provide(
          resumeExecution({
            scopeId,
            executionId,
            payload,
            resumedByScopeId: actorScopeId,
          }),
        ),
    },
  };
};

export const createExecutorEffect = (
  options: CreateExecutorEffectOptions,
): Effect.Effect<ExecutorEffect, Error> =>
  Effect.map(
    options.backend.createRuntime({
      executionResolver: options.executionResolver,
      createInternalToolMap: options.createInternalToolMap,
      resolveSecretMaterial: options.resolveSecretMaterial,
      getLocalServerBaseUrl: options.getLocalServerBaseUrl,
    }),
    fromRuntime,
  );
