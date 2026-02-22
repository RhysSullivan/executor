import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { internal } from "./_generated/api";
import schema from "./schema";
import { registerRateLimiterComponent } from "./testHelpers";

const GITHUB_OPENAPI_SPEC_URL =
  "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json?convex_test_profile=github";

function setup() {
  const t = convexTest(schema, {
    "./database.ts": () => import("./database"),
    "./executorNode.ts": () => import("./executorNode"),
    "./workspaceAuthInternal.ts": () => import("./workspaceAuthInternal"),
    "./toolRegistry.ts": () => import("./toolRegistry"),
    "./openApiSpecCache.ts": () => import("./openApiSpecCache"),
    "./runtimeNode.ts": () => import("./runtimeNode"),
    "./_generated/api.js": () => import("./_generated/api.js"),
  });

  registerRateLimiterComponent(t);
  return t;
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
  const cold = await t.action(internal.executorNode.rebuildToolInventoryInternal, {
    workspaceId: session.workspaceId,
    accountId: session.accountId,
    clientId: session.clientId,
  });
  const coldMs = performance.now() - coldStart;

  const ready = await t.action(internal.executorNode.listToolsWithWarningsInternal, {
    workspaceId: session.workspaceId,
    accountId: session.accountId,
    clientId: session.clientId,
  });

  const warmStart = performance.now();
  const warm = await t.action(internal.executorNode.listToolsWithWarningsInternal, {
    workspaceId: session.workspaceId,
    accountId: session.accountId,
    clientId: session.clientId,
  });
  const warmMs = performance.now() - warmStart;

  console.log(
    `github openapi convex-test profiling: cold=${coldMs.toFixed(0)}ms warm=${warmMs.toFixed(0)}ms tools=${ready.tools.length}`,
  );

  expect(cold.rebuilt).toBe(true);
  expect(ready.totalTools).toBeGreaterThan(500);
  expect(ready.totalTools).toBe(warm.totalTools);
  expect(ready.warnings.some((warning: string) => warning.includes("skipped bundle"))).toBe(false);
  expect(warm.warnings.some((warning: string) => warning.includes("skipped bundle"))).toBe(false);
  expect(ready.typesUrl).toBe(warm.typesUrl);
  expect(ready.inventoryStatus.state).toBe("ready");
  expect(warm.inventoryStatus.state).toBe("ready");
  expect(warm.inventoryStatus.readyToolCount).toBeGreaterThan(500);

  expect(coldMs).toBeLessThan(12_000);
  expect(coldMs).toBeGreaterThan(warmMs * 3);
}, 240_000);

test("convex-test reuses shared OpenAPI artifact cache across workspaces", async () => {
  const t = setup();

  const first = await t.mutation(internal.database.bootstrapAnonymousSession, {});
  await t.mutation(internal.database.upsertToolSource, {
    workspaceId: first.workspaceId,
    name: "github-profile",
    type: "openapi",
    config: {
      spec: GITHUB_OPENAPI_SPEC_URL,
    },
  });

  const firstStart = performance.now();
  await t.action(internal.executorNode.rebuildToolInventoryInternal, {
    workspaceId: first.workspaceId,
    accountId: first.accountId,
    clientId: first.clientId,
  });
  const firstMs = performance.now() - firstStart;

  const second = await t.mutation(internal.database.bootstrapAnonymousSession, {});
  await t.mutation(internal.database.upsertToolSource, {
    workspaceId: second.workspaceId,
    name: "github-profile",
    type: "openapi",
    config: {
      spec: GITHUB_OPENAPI_SPEC_URL,
    },
  });

  const secondStart = performance.now();
  await t.action(internal.executorNode.rebuildToolInventoryInternal, {
    workspaceId: second.workspaceId,
    accountId: second.accountId,
    clientId: second.clientId,
  });
  const secondMs = performance.now() - secondStart;

  console.log(
    `github openapi shared-artifact profile: first=${firstMs.toFixed(0)}ms second=${secondMs.toFixed(0)}ms`,
  );

  expect(firstMs).toBeLessThan(12_000);
  expect(secondMs).toBeLessThan(firstMs * 0.75);
}, 240_000);
