import type {
  InstanceConfig,
} from "../../local/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import type {
  SecretMaterialPurpose,
  SecretRef,
} from "#schema";

export type SecretMaterialResolveContext = {
  params?: Readonly<Record<string, string | undefined>>;
};

export type ResolveSecretMaterial = (input: {
  ref: SecretRef;
  context?: SecretMaterialResolveContext;
}) => Effect.Effect<string, Error, never>;

export type StoreSecretMaterial = (input: {
  purpose: SecretMaterialPurpose;
  value: string;
  name?: string | null;
  storeId?: string;
}) => Effect.Effect<SecretRef, Error, never>;

export type DeleteSecretMaterial = (
  ref: SecretRef,
) => Effect.Effect<boolean, Error, never>;

export type UpdateSecretMaterial = (input: {
  ref: SecretRef;
  name?: string | null;
  value?: string;
}) => Effect.Effect<{
  id: string;
  storeId: string;
  name: string | null;
  purpose: string;
  createdAt: number;
  updatedAt: number;
}, Error, never>;

export type ResolveInstanceConfig = () => Effect.Effect<InstanceConfig, Error, never>;

export class SecretMaterialResolverService extends Context.Tag(
  "#runtime/SecretMaterialResolverService",
)<SecretMaterialResolverService, ResolveSecretMaterial>() {}

export class SecretMaterialStorerService extends Context.Tag(
  "#runtime/SecretMaterialStorerService",
)<SecretMaterialStorerService, StoreSecretMaterial>() {}

export class SecretMaterialDeleterService extends Context.Tag(
  "#runtime/SecretMaterialDeleterService",
)<SecretMaterialDeleterService, DeleteSecretMaterial>() {}

export class SecretMaterialUpdaterService extends Context.Tag(
  "#runtime/SecretMaterialUpdaterService",
)<SecretMaterialUpdaterService, UpdateSecretMaterial>() {}

export class LocalInstanceConfigService extends Context.Tag(
  "#runtime/LocalInstanceConfigService",
)<LocalInstanceConfigService, ResolveInstanceConfig>() {}
