import { SourceStoreError } from "@executor-v2/persistence-ports";
import {
  type LocalStateSnapshot,
  type LocalStateStore,
  type LocalStateStoreError,
} from "@executor-v2/persistence-local";
import {
  makeControlPlaneCredentialsService,
  type ControlPlaneCredentialsServiceShape,
} from "@executor-v2/management-api";
import {
  type OrganizationId,
  type SourceCredentialBinding,
  type WorkspaceId,
} from "@executor-v2/schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

const toSourceStoreError = (
  operation: string,
  message: string,
  details: string | null,
): SourceStoreError =>
  new SourceStoreError({
    operation,
    backend: "local-file",
    location: "snapshot.json",
    message,
    reason: null,
    details,
  });

const toSourceStoreErrorFromLocalState = (
  operation: string,
  error: LocalStateStoreError,
): SourceStoreError =>
  toSourceStoreError(operation, error.message, error.details ?? error.reason ?? null);

const resolveWorkspaceOrganizationId = (
  snapshot: LocalStateSnapshot,
  workspaceId: WorkspaceId,
): OrganizationId => {
  const workspace = snapshot.workspaces.find((item) => item.id === workspaceId);

  if (!workspace) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }

  return workspace.organizationId;
};

const sortCredentialBindings = (
  bindings: ReadonlyArray<SourceCredentialBinding>,
): Array<SourceCredentialBinding> =>
  [...bindings].sort((left, right) => {
    const leftKey = `${left.sourceKey}:${left.provider}:${left.id}`.toLowerCase();
    const rightKey = `${right.sourceKey}:${right.provider}:${right.id}`.toLowerCase();
    return leftKey.localeCompare(rightKey);
  });

const replaceCredentialBindingAt = (
  snapshot: LocalStateSnapshot,
  index: number,
  binding: SourceCredentialBinding,
): LocalStateSnapshot => {
  const next = [...snapshot.credentialBindings];
  next[index] = binding;

  return {
    ...snapshot,
    generatedAt: Date.now(),
    credentialBindings: next,
  };
};

const appendCredentialBinding = (
  snapshot: LocalStateSnapshot,
  binding: SourceCredentialBinding,
): LocalStateSnapshot => ({
  ...snapshot,
  generatedAt: Date.now(),
  credentialBindings: [...snapshot.credentialBindings, binding],
});

const removeCredentialBindingForWorkspace = (
  snapshot: LocalStateSnapshot,
  workspaceId: WorkspaceId,
  credentialBindingId: string,
): { snapshot: LocalStateSnapshot; removed: boolean } => {
  const organizationId = resolveWorkspaceOrganizationId(snapshot, workspaceId);
  const removeIndex = snapshot.credentialBindings.findIndex(
    (binding) =>
      binding.id === credentialBindingId
      && (
        binding.workspaceId === workspaceId
        || (binding.workspaceId === null && binding.organizationId === organizationId)
      ),
  );

  if (removeIndex < 0) {
    return {
      snapshot,
      removed: false,
    };
  }

  const next = [...snapshot.credentialBindings];
  next.splice(removeIndex, 1);

  return {
    removed: true,
    snapshot: {
      ...snapshot,
      generatedAt: Date.now(),
      credentialBindings: next,
    },
  };
};

export const createPmCredentialsService = (
  localStateStore: LocalStateStore,
): ControlPlaneCredentialsServiceShape =>
  makeControlPlaneCredentialsService({
    listCredentialBindings: (workspaceId) =>
      Effect.gen(function* () {
        const snapshotOption = yield* localStateStore.getSnapshot().pipe(
          Effect.mapError((error) =>
            toSourceStoreErrorFromLocalState("credentials.list", error),
          ),
        );

        const snapshot = Option.getOrNull(snapshotOption);
        if (snapshot === null) {
          return [];
        }

        const organizationId = resolveWorkspaceOrganizationId(snapshot, workspaceId);

        return sortCredentialBindings(
          snapshot.credentialBindings.filter(
            (binding) =>
              binding.workspaceId === workspaceId
              || (binding.workspaceId === null && binding.organizationId === organizationId),
          ),
        );
      }),

    upsertCredentialBinding: (input) =>
      Effect.gen(function* () {
        const snapshotOption = yield* localStateStore.getSnapshot().pipe(
          Effect.mapError((error) =>
            toSourceStoreErrorFromLocalState("credentials.upsert", error),
          ),
        );

        const snapshot = Option.getOrNull(snapshotOption);
        if (snapshot === null) {
          return yield* toSourceStoreError(
            "credentials.upsert",
            "Credential snapshot not found",
            `workspace=${input.workspaceId}`,
          );
        }

        if (input.payload.scopeType === "account" && input.payload.accountId === null) {
          return yield* toSourceStoreError(
            "credentials.upsert",
            "Account scope credentials require accountId",
            `workspace=${input.workspaceId}`,
          );
        }

        const now = Date.now();
        const requestedId = input.payload.id;

        const existingIndex = requestedId
          ? snapshot.credentialBindings.findIndex(
              (binding) =>
                binding.workspaceId === input.workspaceId && binding.id === requestedId,
            )
          : -1;

        const existing = existingIndex >= 0 ? snapshot.credentialBindings[existingIndex] : null;
        const organizationId = resolveWorkspaceOrganizationId(snapshot, input.workspaceId);

        const nextBinding: SourceCredentialBinding = {
          id:
            existing?.id
            ?? (requestedId
              ?? (`credential_binding_${crypto.randomUUID()}` as SourceCredentialBinding["id"])),
          credentialId: input.payload.credentialId,
          organizationId,
          workspaceId:
            input.payload.scopeType === "workspace" ? input.workspaceId : null,
          accountId:
            input.payload.scopeType === "account"
              ? (input.payload.accountId ?? null)
              : null,
          scopeType: input.payload.scopeType,
          sourceKey: input.payload.sourceKey,
          provider: input.payload.provider,
          secretProvider:
            input.payload.secretProvider
            ?? existing?.secretProvider
            ?? "local",
          secretRef: input.payload.secretRef,
          additionalHeadersJson: input.payload.additionalHeadersJson ?? null,
          boundAuthFingerprint: input.payload.boundAuthFingerprint ?? null,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };

        const nextSnapshot = existingIndex >= 0
          ? replaceCredentialBindingAt(snapshot, existingIndex, nextBinding)
          : appendCredentialBinding(snapshot, nextBinding);

        yield* localStateStore.writeSnapshot(nextSnapshot).pipe(
          Effect.mapError((error) =>
            toSourceStoreErrorFromLocalState("credentials.upsert_write", error),
          ),
        );

        return nextBinding;
      }),

    removeCredentialBinding: (input) =>
      Effect.gen(function* () {
        const snapshotOption = yield* localStateStore.getSnapshot().pipe(
          Effect.mapError((error) =>
            toSourceStoreErrorFromLocalState("credentials.remove", error),
          ),
        );

        const snapshot = Option.getOrNull(snapshotOption);
        if (snapshot === null) {
          return {
            removed: false,
          };
        }

        const next = removeCredentialBindingForWorkspace(
          snapshot,
          input.workspaceId,
          input.credentialBindingId,
        );

        if (!next.removed) {
          return {
            removed: false,
          };
        }

        yield* localStateStore.writeSnapshot(next.snapshot).pipe(
          Effect.mapError((error) =>
            toSourceStoreErrorFromLocalState("credentials.remove_write", error),
          ),
        );

        return {
          removed: true,
        };
      }),
  });
