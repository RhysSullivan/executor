import { Atom } from "@effect-atom/atom";
import type {
  RemoveCredentialBindingResult,
  UpsertCredentialBindingPayload,
} from "@executor-v2/management-api/credentials/api";
import type {
  CredentialProvider,
  CredentialScopeType,
  SourceCredentialBinding,
  WorkspaceId,
} from "@executor-v2/schema";

import { controlPlaneClient } from "../client";
import { workspaceEntity, type EntityState } from "./entity";
import { credentialsKeys, credentialsMutationKeys } from "./keys";

// ---------------------------------------------------------------------------
// Query atoms
// ---------------------------------------------------------------------------

export const credentialBindingsResultByWorkspace = Atom.family(
  (workspaceId: WorkspaceId) =>
    controlPlaneClient.query("credentials", "list", {
      path: { workspaceId },
      reactivityKeys: credentialsKeys(workspaceId),
    }),
);

// ---------------------------------------------------------------------------
// Derived state
// ---------------------------------------------------------------------------

const sortCredentialBindings = (a: SourceCredentialBinding, b: SourceCredentialBinding): number => {
  const aKey = `${a.sourceKey}:${a.provider}`.toLowerCase();
  const bKey = `${b.sourceKey}:${b.provider}`.toLowerCase();
  if (aKey === bKey) return `${a.workspaceId}:${a.id}`.localeCompare(`${b.workspaceId}:${b.id}`);
  return aKey.localeCompare(bKey);
};

export const credentialBindingsByWorkspace = workspaceEntity(
  credentialBindingsResultByWorkspace,
  sortCredentialBindings,
);

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export const upsertCredentialBinding = controlPlaneClient.mutation("credentials", "upsert");
export const removeCredentialBinding = controlPlaneClient.mutation("credentials", "remove");

// ---------------------------------------------------------------------------
// Payload helpers
// ---------------------------------------------------------------------------

export const toCredentialBindingUpsertPayload = (input: {
  id?: SourceCredentialBinding["id"];
  credentialId: SourceCredentialBinding["credentialId"];
  scopeType: CredentialScopeType;
  sourceKey: string;
  provider: CredentialProvider;
  secret: string;
  accountId?: SourceCredentialBinding["accountId"];
  additionalHeadersJson?: SourceCredentialBinding["additionalHeadersJson"];
  boundAuthFingerprint?: SourceCredentialBinding["boundAuthFingerprint"];
  oauthRefreshToken?: string | null;
  oauthExpiresAt?: number | null;
  oauthScope?: string | null;
  oauthIssuer?: string | null;
  oauthTokenEndpoint?: string | null;
  oauthAuthorizationServer?: string | null;
  oauthClientId?: string | null;
  oauthClientSecret?: string | null;
  oauthSourceUrl?: string | null;
  oauthClientInformationJson?: string | null;
}): UpsertCredentialBindingPayload => ({
  ...(input.id ? { id: input.id } : {}),
  credentialId: input.credentialId,
  scopeType: input.scopeType,
  sourceKey: input.sourceKey,
  provider: input.provider,
  secret: input.secret,
  ...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
  ...(input.additionalHeadersJson !== undefined
    ? { additionalHeadersJson: input.additionalHeadersJson }
    : {}),
  ...(input.boundAuthFingerprint !== undefined
    ? { boundAuthFingerprint: input.boundAuthFingerprint }
    : {}),
  ...(input.oauthRefreshToken !== undefined
    ? { oauthRefreshToken: input.oauthRefreshToken }
    : {}),
  ...(input.oauthExpiresAt !== undefined
    ? { oauthExpiresAt: input.oauthExpiresAt }
    : {}),
  ...(input.oauthScope !== undefined ? { oauthScope: input.oauthScope } : {}),
  ...(input.oauthIssuer !== undefined ? { oauthIssuer: input.oauthIssuer } : {}),
  ...(input.oauthTokenEndpoint !== undefined
    ? { oauthTokenEndpoint: input.oauthTokenEndpoint }
    : {}),
  ...(input.oauthAuthorizationServer !== undefined
    ? { oauthAuthorizationServer: input.oauthAuthorizationServer }
    : {}),
  ...(input.oauthClientId !== undefined
    ? { oauthClientId: input.oauthClientId }
    : {}),
  ...(input.oauthClientSecret !== undefined
    ? { oauthClientSecret: input.oauthClientSecret }
    : {}),
  ...(input.oauthSourceUrl !== undefined
    ? { oauthSourceUrl: input.oauthSourceUrl }
    : {}),
  ...(input.oauthClientInformationJson !== undefined
    ? { oauthClientInformationJson: input.oauthClientInformationJson }
    : {}),
});

export const toCredentialBindingUpsertRequest = (input: {
  workspaceId: WorkspaceId;
  payload: UpsertCredentialBindingPayload;
}) => ({
  path: { workspaceId: input.workspaceId },
  payload: input.payload,
  reactivityKeys: credentialsMutationKeys(input.workspaceId),
});

export const toCredentialBindingRemoveRequest = (input: {
  workspaceId: WorkspaceId;
  credentialBindingId: SourceCredentialBinding["id"];
}) => ({
  path: {
    workspaceId: input.workspaceId,
    credentialBindingId: input.credentialBindingId,
  },
  reactivityKeys: credentialsMutationKeys(input.workspaceId),
});

export const toCredentialBindingRemoveResult = (
  result: RemoveCredentialBindingResult,
): boolean => result.removed;

export type CredentialBindingsState = EntityState<SourceCredentialBinding>;
