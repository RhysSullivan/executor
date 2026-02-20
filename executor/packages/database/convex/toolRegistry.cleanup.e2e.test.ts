import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { internal } from "./_generated/api";
import schema from "./schema";
import { registerRateLimiterComponent } from "./testHelpers";

function setup() {
  const t = convexTest(schema, {
    "./database.ts": () => import("./database"),
    "./toolRegistry.ts": () => import("./toolRegistry"),
    "./workspaceAuthInternal.ts": () => import("./workspaceAuthInternal"),
    "./_generated/api.js": () => import("./_generated/api.js"),
  });

  registerRateLimiterComponent(t);
  return t;
}

function makeRegistryTool(path: string, source = "openapi:bulk") {
  return {
    path,
    preferredPath: path,
    namespace: path.split(".")[0] ?? "bulk",
    normalizedPath: path.toLowerCase(),
    aliases: [],
    description: `Tool ${path}`,
    approval: "auto" as const,
    source,
    searchText: `${path} ${source}`,
    displayInput: "{}",
    displayOutput: "{ ok: boolean }",
    requiredInputKeys: [],
    previewInputKeys: [],
    serializedToolJson: JSON.stringify({
      path,
      description: `Tool ${path}`,
      approval: "auto",
      source,
    }),
  };
}

describe("toolRegistry cleanup", () => {
  test("putToolsBatch keeps a single row per workspace/path", async () => {
    const t = setup();
    const session = await t.mutation(internal.database.bootstrapAnonymousSession, {});

    await t.mutation(internal.toolRegistry.putToolsBatch, {
      workspaceId: session.workspaceId,
      tools: [makeRegistryTool("bulk.same_path")],
    });

    await t.mutation(internal.toolRegistry.putToolsBatch, {
      workspaceId: session.workspaceId,
      tools: [makeRegistryTool("bulk.same_path")],
    });

    const page = await t.query(internal.toolRegistry.listToolsPage, {
      workspaceId: session.workspaceId,
      limit: 50,
    });

    expect(page.items.filter((item) => item.path === "bulk.same_path").length).toBe(1);
  });

  test("deleteToolsBySource action pages through large source inventories", async () => {
    const t = setup();
    const session = await t.mutation(internal.database.bootstrapAnonymousSession, {});

    const total = 1600;
    const batchSize = 100;
    for (let i = 0; i < total; i += batchSize) {
      const tools = Array.from({ length: Math.min(batchSize, total - i) }, (_, offset) =>
        makeRegistryTool(`bulk.tool_${i + offset}`, "openapi:bulk"),
      );

      await t.mutation(internal.toolRegistry.putToolsBatch, {
        workspaceId: session.workspaceId,
        tools,
      });
    }

    const removed = await t.action(internal.toolRegistry.deleteToolsBySource, {
      workspaceId: session.workspaceId,
      source: "openapi:bulk",
    });

    expect(removed.removed).toBe(total);

    const remaining = await t.query(internal.toolRegistry.listToolsBySourcePage, {
      workspaceId: session.workspaceId,
      source: "openapi:bulk",
      limit: 50,
    });

    expect(remaining.items.length).toBe(0);
    expect(remaining.continueCursor).toBeNull();
  }, 120_000);
});
