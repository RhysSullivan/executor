import { describe, it, expect } from "@effect/vitest";
import { Effect } from "effect";

import { createExecutor, makeTestConfig } from "@executor/sdk";

import { openApiPlugin } from "./plugin";

// The openapi plugin ships its own skills under its own sourceId —
// NOT via the global skillsPlugin. These tests pin that attachment:
// `tools.list({ sourceId: "openapi" })` returns the playbook
// alongside the operations, no naming-convention substring trick
// needed. See notes/skills.md for why.

describe("openapi-owned skills", () => {
  it.effect("the playbook lives under sourceId `openapi`, next to previewSpec/addSource", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [openApiPlugin()] as const }),
      );

      const tools = yield* executor.tools.list({ sourceId: "openapi" });
      const ids = tools.map((t) => t.id).sort();

      // ASCII order: uppercase S in `addSource` sorts before lowercase
      // i in `adding-a-source`.
      expect(ids).toEqual([
        "openapi.addSource",
        "openapi.adding-a-source",
        "openapi.previewSpec",
      ]);
    }),
  );

  it.effect("skill description uses the `Skill:` prefix shared across skill helpers", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [openApiPlugin()] as const }),
      );

      const tools = yield* executor.tools.list({ sourceId: "openapi" });
      const skill = tools.find((t) => t.id === "openapi.adding-a-source");
      expect(skill?.description.startsWith("Skill: ")).toBe(true);
    }),
  );

  it.effect("invoking the skill returns markdown that references the real tools", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [openApiPlugin()] as const }),
      );

      const body = (yield* executor.tools.invoke(
        "openapi.adding-a-source",
        {},
      )) as string;

      // If a tool gets renamed, the skill goes stale — catch it here.
      expect(body).toContain("openapi.previewSpec");
      expect(body).toContain("openapi.addSource");
    }),
  );

  // Pins the "no secret values in chat" policy. If a future edit
  // reintroduces the old `secrets.set` instruction, this fails —
  // that pattern routes user-typed secrets through the LLM context.
  it.effect("skill body never tells the agent to secrets.set a user-typed value", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [openApiPlugin()] as const }),
      );

      const body = (yield* executor.tools.invoke(
        "openapi.adding-a-source",
        {},
      )) as string;

      expect(body).not.toContain("store it via `secrets.set`");
      expect(body).toContain("Never accept a secret value in-chat");
    }),
  );
});
