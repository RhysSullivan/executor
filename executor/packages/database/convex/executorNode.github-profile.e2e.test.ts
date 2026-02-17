import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { internal } from "./_generated/api";
import schema from "./schema";

const GITHUB_OPENAPI_SPEC_URL =
  "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json?convex_test_profile=github";

function setup() {
  return convexTest(schema, {
    "./database.ts": () => import("./database"),
    "./executorNode.ts": () => import("./executorNode"),
    "./workspaceAuthInternal.ts": () => import("./workspaceAuthInternal"),
    "./toolRegistry.ts": () => import("./toolRegistry"),
    "./openApiSpecCache.ts": () => import("./openApiSpecCache"),
    "./_generated/api.js": () => import("./_generated/api.js"),
  });
}

test("convex-test keeps GitHub inventory build warm-cache fast", async () => {
  const t = setup();
  const session = await t.mutation(internal.database.bootstrapAnonymousSession, {});

  await t.mutation(internal.database.upsertToolSource, {
    workspaceId: session.workspaceId,
    name: "github-profile",
    type: "openapi",
    config: {
      spec: GITHUB_OPENAPI_SPEC_URL,
    },
  });

  const coldStart = performance.now();
  const cold = await t.action(internal.executorNode.listToolsWithWarningsInternal, {
    workspaceId: session.workspaceId,
    accountId: session.accountId,
    clientId: session.clientId,
  });
  const coldMs = performance.now() - coldStart;

  const warmStart = performance.now();
  const warm = await t.action(internal.executorNode.listToolsWithWarningsInternal, {
    workspaceId: session.workspaceId,
    accountId: session.accountId,
    clientId: session.clientId,
  });
  const warmMs = performance.now() - warmStart;

  console.log(
    `github openapi convex-test profiling: cold=${coldMs.toFixed(0)}ms warm=${warmMs.toFixed(0)}ms tools=${cold.tools.length}`,
  );

  expect(cold.tools.length).toBeGreaterThan(500);
  expect(cold.tools.length).toBe(warm.tools.length);
  expect(cold.warnings.some((warning: string) => warning.includes("skipped bundle"))).toBe(false);
  expect(warm.warnings.some((warning: string) => warning.includes("skipped bundle"))).toBe(false);
  expect(typeof cold.typesUrl).toBe("string");
  expect(typeof warm.typesUrl).toBe("string");
  expect(cold.typesUrl).toBe(warm.typesUrl);
  expect(cold.inventoryStatus.state).toBe("ready");
  expect(warm.inventoryStatus.state).toBe("ready");
  expect(warm.inventoryStatus.readyToolCount).toBeGreaterThan(500);

  expect(coldMs).toBeLessThan(12_000);
  expect(coldMs).toBeGreaterThan(warmMs * 3);
}, 240_000);
