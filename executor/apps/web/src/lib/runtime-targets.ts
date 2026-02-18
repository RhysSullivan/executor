import type { RuntimeTargetDescriptor } from "@/lib/types";

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

function isRuntimeEnabled(runtimeId: string): boolean {
  if (runtimeId !== LOCAL_BUN_RUNTIME_ID && runtimeId !== CLOUDFLARE_WORKER_LOADER_RUNTIME_ID) {
    return false;
  }

  const localVmAllowed =
    typeof process !== "undefined"
      ? isTruthyEnvValue(process.env[DANGEROUSLY_ALLOW_LOCAL_VM_ENV_KEY])
      : false;

  if (localVmAllowed) {
    return true;
  }

  return runtimeId === CLOUDFLARE_WORKER_LOADER_RUNTIME_ID;
}

export function listRuntimeTargets(): RuntimeTargetDescriptor[] {
  return RUNTIME_TARGETS.filter((target) => isRuntimeEnabled(target.id));
}
