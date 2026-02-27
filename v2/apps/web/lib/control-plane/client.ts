import { createControlPlaneAtomClient } from "@executor-v2/control-plane";

const controlPlaneBaseUrl =
  typeof window === "undefined"
    ? process.env.CONTROL_PLANE_SERVER_BASE_URL ??
      process.env.NEXT_PUBLIC_CONTROL_PLANE_BASE_URL ??
      "http://127.0.0.1:3000/api/control-plane"
    : process.env.NEXT_PUBLIC_CONTROL_PLANE_BASE_URL ?? "/api/control-plane";

export const controlPlaneClient = createControlPlaneAtomClient({
  baseUrl: controlPlaneBaseUrl,
});
