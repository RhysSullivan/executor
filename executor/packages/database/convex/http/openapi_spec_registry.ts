import type { OpenApiFunctionSpec, ValidatorJson } from "./openapi_spec";

type ConvexPublicRegistration = {
  isPublic?: boolean;
  isQuery?: boolean;
  isMutation?: boolean;
  isAction?: boolean;
  exportArgs?: () => ValidatorJson | null;
  exportReturns?: () => ValidatorJson | null;
};

function readValidator(
  fn: ConvexPublicRegistration,
  key: "exportArgs" | "exportReturns",
): ValidatorJson | string | null {
  try {
    return fn[key]?.() ?? null;
  } catch {
    return null;
  }
}

function collectFromModule(modulePath: string, exportsObject: Record<string, unknown>): OpenApiFunctionSpec[] {
  const functions: OpenApiFunctionSpec[] = [];

  for (const [exportName, value] of Object.entries(exportsObject)) {
    if (typeof value !== "function") {
      continue;
    }

    const fn = value as ConvexPublicRegistration;
    if (!fn.isPublic) {
      continue;
    }

    const functionType = fn.isQuery ? "query" : fn.isMutation ? "mutation" : fn.isAction ? "action" : null;
    if (!functionType) {
      continue;
    }

    functions.push({
      identifier: `${modulePath}:${exportName}`,
      functionType,
      method: functionType === "query" ? "GET" : "POST",
      args: readValidator(fn, "exportArgs"),
      returns: readValidator(fn, "exportReturns"),
    });
  }

  return functions;
}

const moduleLoaders: Array<{
  modulePath: string;
  load: () => Promise<Record<string, unknown>>;
}> = [
  { modulePath: "accounts", load: () => import("../accounts") },
  { modulePath: "app", load: () => import("../app") },
  { modulePath: "auth", load: () => import("../auth") },
  { modulePath: "billing", load: () => import("../billing") },
  { modulePath: "executor", load: () => import("../executor") },
  { modulePath: "invites", load: () => import("../invites") },
  { modulePath: "organizationMembers", load: () => import("../organizationMembers") },
  { modulePath: "organizations", load: () => import("../organizations") },
  { modulePath: "runtimeCallbacks", load: () => import("../runtimeCallbacks") },
  { modulePath: "workspace", load: () => import("../workspace") },
  { modulePath: "workspaces", load: () => import("../workspaces") },
];

export async function collectPublicFunctionSpecs(): Promise<OpenApiFunctionSpec[]> {
  const moduleFunctions: OpenApiFunctionSpec[] = [];

  for (const loader of moduleLoaders) {
    try {
      const exportsObject = await loader.load();
      moduleFunctions.push(...collectFromModule(loader.modulePath, exportsObject));
    } catch {
      // Skip modules that are unavailable in the current runtime.
    }
  }

  // Node runtime public actions are declared in "use node" files and are added manually.
  const nodeRuntimeFunctions: OpenApiFunctionSpec[] = [
    {
      identifier: "credentialsNode:upsertCredential",
      functionType: "action",
      method: "POST",
      args: { type: "any" },
      returns: { type: "any" },
    },
    {
      identifier: "executorNode:listToolsWithWarnings",
      functionType: "action",
      method: "POST",
      args: { type: "any" },
      returns: { type: "any" },
    },
  ];

  const merged = [...moduleFunctions, ...nodeRuntimeFunctions];
  merged.sort((a, b) => a.identifier.localeCompare(b.identifier));
  return merged;
}
