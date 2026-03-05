import { type SourceStoreError } from "@executor-v2/persistence-ports";
import { type Organization } from "@executor-v2/schema";
import * as Effect from "effect/Effect";

import type { UpsertOrganizationPayload } from "./api";

export type UpsertOrganizationInput = {
  payload: UpsertOrganizationPayload;
};

export type ControlPlaneOrganizationsServiceShape = {
  listOrganizations: () => Effect.Effect<ReadonlyArray<Organization>, SourceStoreError>;
  upsertOrganization: (
    input: UpsertOrganizationInput,
  ) => Effect.Effect<Organization, SourceStoreError>;
};

export const makeControlPlaneOrganizationsService = (
  service: ControlPlaneOrganizationsServiceShape,
): ControlPlaneOrganizationsServiceShape => service;
