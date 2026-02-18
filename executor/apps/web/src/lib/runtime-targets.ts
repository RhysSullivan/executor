import type { RuntimeTargetDescriptor } from "@/lib/types";
import { readRuntimeConfig } from "@/lib/runtime-config";

const LOCAL_BUN_RUNTIME_ID = "local-bun";
const CLOUDFLARE_WORKER_LOADER_RUNTIME_ID = "cloudflare-worker-loader";
const DANGEROUSLY_ALLOW_LOCAL_VM_ENV_KEY = "DANGEROUSLY_ALLOW_LOCAL_VM";

const TRUTHY_ENV_VALUES = new Set(["1", "true", "yes", "on"]);

const RUNTIME_TARGETS: RuntimeTargetDescriptor[] = [
  {
    id: LOCAL_BUN_RUNTIME_ID,
    label: "Local JS Runtime",
    description: "Runs generated code in-process using Bun",
  },
  {
    id: CLOUDFLARE_WORKER_LOADER_RUNTIME_ID,
    label: "Cloudflare Worker Loader",
    description: "Runs generated code in a Cloudflare Worker",
  },
];

function isTruthyEnvValue(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  return TRUTHY_ENV_VALUES.has(value.trim().toLowerCase());
}

function resolveLocalVmAllowed(override?: boolean): boolean {
  if (typeof override === "boolean") {
    return override;
  }

  const fromRuntimeConfig = readRuntimeConfig().allowLocalVm;
  if (typeof fromRuntimeConfig === "boolean") {
    return fromRuntimeConfig;
  }

  return typeof process !== "undefined"
    ? isTruthyEnvValue(process.env[DANGEROUSLY_ALLOW_LOCAL_VM_ENV_KEY])
    : false;
}

function isRuntimeEnabled(runtimeId: string, localVmAllowed: boolean): boolean {
  if (runtimeId !== LOCAL_BUN_RUNTIME_ID && runtimeId !== CLOUDFLARE_WORKER_LOADER_RUNTIME_ID) {
    return false;
  }

  if (localVmAllowed) {
    return true;
  }

  return runtimeId === CLOUDFLARE_WORKER_LOADER_RUNTIME_ID;
}

export function listRuntimeTargets(): RuntimeTargetDescriptor[] {
  return listRuntimeTargetsWithOptions({});
}

export function listRuntimeTargetsWithOptions(options: { allowLocalVm?: boolean }): RuntimeTargetDescriptor[] {
  const localVmAllowed = resolveLocalVmAllowed(options.allowLocalVm);
  return RUNTIME_TARGETS.filter((target) => isRuntimeEnabled(target.id, localVmAllowed));
}
