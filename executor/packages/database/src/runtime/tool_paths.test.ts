import { expect, test } from "bun:test";
import type { ToolDefinition } from "../../../core/src/types";
import { resolveAliasedToolPath, resolveClosestToolPath, toPreferredToolPath } from "./tool_paths";

function makeTool(path: string): ToolDefinition {
  return {
    path,
    description: path,
    approval: "auto",
    source: "test",
    run: async () => null,
  };
}

test("resolveAliasedToolPath matches simplified vendor namespace aliases", () => {
  const tools = new Map<string, ToolDefinition>([
    ["vercel_vercel_api.domains.get_domain", makeTool("vercel_vercel_api.domains.get_domain")],
  ]);

  const resolved = resolveAliasedToolPath("vercel.domains.get_domain", tools);
  expect(resolved).toBe("vercel_vercel_api.domains.get_domain");
});

test("resolveClosestToolPath heals small typos safely", () => {
  const tools = new Map<string, ToolDefinition>([
    ["vercel_vercel_api.dns.update_record", makeTool("vercel_vercel_api.dns.update_record")],
    ["vercel_vercel_api.dns.get_records", makeTool("vercel_vercel_api.dns.get_records")],
  ]);

  const healed = resolveClosestToolPath("vercel.dns.updte_record", tools);
  expect(healed).toBe("vercel_vercel_api.dns.update_record");
});

test("toPreferredToolPath simplifies ugly source namespace", () => {
  expect(toPreferredToolPath("vercel_vercel_api.dns.get_records")).toBe("vercel.dns.get_records");
});
