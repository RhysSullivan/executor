import * as Context from "effect/Context";

import { type ControlPlaneCredentialsServiceShape } from "./credentials/service";
import { type ControlPlaneInteractionsServiceShape } from "./interactions/service";
import { type ControlPlaneOrganizationsServiceShape } from "./organizations/service";
import { type ControlPlanePoliciesServiceShape } from "./policies/service";
import { type ControlPlaneStorageServiceShape } from "./storage/service";
import { type ControlPlaneSourcesServiceShape } from "./sources/service";
import { type ControlPlaneToolsServiceShape } from "./tools/service";
import { type ControlPlaneWorkspacesServiceShape } from "./workspaces/service";

export type ControlPlaneServiceShape = ControlPlaneSourcesServiceShape &
  ControlPlaneCredentialsServiceShape &
  ControlPlanePoliciesServiceShape &
  ControlPlaneOrganizationsServiceShape &
  ControlPlaneWorkspacesServiceShape &
  ControlPlaneToolsServiceShape &
  ControlPlaneStorageServiceShape &
  ControlPlaneInteractionsServiceShape;

export class ControlPlaneService extends Context.Tag("@executor-v2/management-api/ControlPlaneService")<
  ControlPlaneService,
  ControlPlaneServiceShape
>() {}

export const makeControlPlaneService = (services: {
  sources: ControlPlaneSourcesServiceShape;
  credentials: ControlPlaneCredentialsServiceShape;
  policies: ControlPlanePoliciesServiceShape;
  organizations: ControlPlaneOrganizationsServiceShape;
  workspaces: ControlPlaneWorkspacesServiceShape;
  tools: ControlPlaneToolsServiceShape;
  storage: ControlPlaneStorageServiceShape;
  interactions: ControlPlaneInteractionsServiceShape;
}): ControlPlaneServiceShape => ({
  ...services.sources,
  ...services.credentials,
  ...services.policies,
  ...services.organizations,
  ...services.workspaces,
  ...services.tools,
  ...services.storage,
  ...services.interactions,
});
