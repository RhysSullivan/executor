import { createControlPlaneAtomClient } from "@executor-v2/management-api/client";
import { ControlPlaneAuthHeaders } from "@executor-v2/management-api/auth/principal";

const trim = (value: string | undefined): string | undefined => {
  const candidate = value?.trim();
  return candidate && candidate.length > 0 ? candidate : undefined;
};

const defaultControlPlaneBaseUrl = "http://127.0.0.1:8788";

const controlPlaneBaseUrl =
  typeof window === "undefined"
    ? trim(process.env.CONTROL_PLANE_SERVER_BASE_URL)
      ?? trim(process.env.CONTROL_PLANE_UPSTREAM_URL)
      ?? trim(process.env.NEXT_PUBLIC_CONTROL_PLANE_BASE_URL)
      ?? defaultControlPlaneBaseUrl
    : trim(process.env.NEXT_PUBLIC_CONTROL_PLANE_BASE_URL)
      ?? defaultControlPlaneBaseUrl;

const controlPlaneAccountId = process.env.NEXT_PUBLIC_CONTROL_PLANE_ACCOUNT_ID;

const controlPlaneHeaders =
  controlPlaneAccountId === undefined || controlPlaneAccountId.trim().length === 0
    ? undefined
    : {
        [ControlPlaneAuthHeaders.accountId]: controlPlaneAccountId,
      };

export const controlPlaneClient = createControlPlaneAtomClient({
  baseUrl: controlPlaneBaseUrl,
  headers: controlPlaneHeaders,
});
