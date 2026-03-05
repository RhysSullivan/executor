import { createControlPlaneAtomClient } from "@executor-v2/management-api/client";

const defaultControlPlaneBaseUrl = "/api/control-plane";

export const controlPlaneClient = createControlPlaneAtomClient({
  baseUrl: defaultControlPlaneBaseUrl,
});
