import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import {
  BrowseSecretStorePayloadSchema,
  BrowseSecretStoreResultSchema,
  CreateSecretPayloadSchema,
  CreateSecretResultSchema,
  CreateSecretStorePayloadSchema,
  DeleteSecretResultSchema,
  DeleteSecretStoreResultSchema,
  ImportSecretFromStorePayloadSchema,
  InstanceConfigSchema,
  SecretListItemSchema,
  SecretStoreSchema,
  UpdateSecretPayloadSchema,
  UpdateSecretResultSchema,
  UpdateSecretStorePayloadSchema,
} from "@executor/platform-sdk/contracts";
import {
  ControlPlaneBadRequestError,
  ControlPlaneNotFoundError,
  ControlPlaneStorageError,
} from "@executor/platform-sdk/errors";
import { LocalInstallationSchema } from "@executor/platform-sdk/schema";
import * as Schema from "effect/Schema";

export type {
  BrowseSecretStorePayload,
  BrowseSecretStoreResult,
  CreateSecretPayload,
  CreateSecretResult,
  DeleteSecretResult,
  DeleteSecretStoreResult,
  CreateSecretStorePayload,
  ImportSecretFromStorePayload,
  InstanceConfig,
  SecretLinkedSource,
  SecretListItem,
  SecretProvider,
  SecretStoreBrowseEntry,
  SecretStore,
  UpdateSecretPayload,
  UpdateSecretResult,
  UpdateSecretStorePayload,
} from "@executor/platform-sdk/contracts";

export class LocalApi extends HttpApiGroup.make("local")
  .add(
    HttpApiEndpoint.get("installation")`/local/installation`
      .addSuccess(LocalInstallationSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.get("config")`/local/config`
      .addSuccess(InstanceConfigSchema)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.get("listSecretStores")`/local/secret-stores`
      .addSuccess(Schema.Array(SecretStoreSchema))
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.post("createSecretStore")`/local/secret-stores`
      .setPayload(CreateSecretStorePayloadSchema)
      .addSuccess(SecretStoreSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.patch("updateSecretStore")`/local/secret-stores/${HttpApiSchema.param("storeId", Schema.String)}`
      .setPayload(UpdateSecretStorePayloadSchema)
      .addSuccess(SecretStoreSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.del("deleteSecretStore")`/local/secret-stores/${HttpApiSchema.param("storeId", Schema.String)}`
      .addSuccess(DeleteSecretStoreResultSchema)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.post("browseSecretStore")`/local/secret-stores/${HttpApiSchema.param("storeId", Schema.String)}/browse`
      .setPayload(BrowseSecretStorePayloadSchema)
      .addSuccess(BrowseSecretStoreResultSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.post("importSecretFromStore")`/local/secret-stores/${HttpApiSchema.param("storeId", Schema.String)}/import`
      .setPayload(ImportSecretFromStorePayloadSchema)
      .addSuccess(CreateSecretResultSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.get("listSecrets")`/local/secrets`
      .addSuccess(Schema.Array(SecretListItemSchema))
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.post("createSecret")`/local/secrets`
      .setPayload(CreateSecretPayloadSchema)
      .addSuccess(CreateSecretResultSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.patch("updateSecret")`/local/secrets/${HttpApiSchema.param("secretId", Schema.String)}`
      .setPayload(UpdateSecretPayloadSchema)
      .addSuccess(UpdateSecretResultSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.del("deleteSecret")`/local/secrets/${HttpApiSchema.param("secretId", Schema.String)}`
      .addSuccess(DeleteSecretResultSchema)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .prefix("/v1") {}
