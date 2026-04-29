import { describe, it, expect } from "@effect/vitest";
import { Effect } from "effect";

import { createExecutor, makeTestConfig } from "@executor/sdk";

import { skillsPlugin, type Skill } from "./index";

// These tests double as executable documentation for the "skills are
// tools" UX. Everything an agent does with a skill goes through the
// normal tool catalog API: `tools.list({ query })` to discover,
// `tools.invoke(id)` to load the body. If this file ever stops reading
// like the agent-facing flow, the plugin has drifted.

const sampleSkills: readonly Skill[] = [
  {
    id: "demo.hello",
    description: "Say hello to the world",
    body: "# Hello\n\nThis is the hello skill body.",
  },
  {
    id: "demo.setup-auth",
    description: "How to wire API key auth for the demo API",
    body: "# Setup\n\n1. Store the key as a secret.\n2. Reference it from headers.",
  },
];

describe("skillsPlugin — agent discovery UX", () => {
  it.effect("skills show up in tools.list under the `skills` source", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [skillsPlugin({ skills: sampleSkills })] as const,
        }),
      );

      // Filtering by sourceId is the "give me only skills" query.
      const tools = yield* executor.tools.list({ sourceId: "skills" });
      const ids = tools.map((t) => t.id).sort();

      expect(ids).toEqual(["skills.demo.hello", "skills.demo.setup-auth"]);
    }),
  );

  it.effect("descriptions are prefixed `Skill: ` so agents can tell them apart", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [skillsPlugin({ skills: sampleSkills })] as const,
        }),
      );

      const [tool] = yield* executor.tools.list({
        sourceId: "skills",
        query: "hello",
      });
      expect(tool.description).toBe("Skill: Say hello to the world");
    }),
  );

  it.effect("query matches against skill id AND description", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [skillsPlugin({ skills: sampleSkills })] as const,
        }),
      );

      // Match via the description ("auth" isn't in the id directly, but is
      // close — "setup-auth" contains it. Let's pick a word only in the
      // description to make sure description text is indexed.)
      const byDescription = yield* executor.tools.list({ query: "wire" });
      expect(byDescription.map((t) => t.id)).toEqual(["skills.demo.setup-auth"]);

      const byId = yield* executor.tools.list({ query: "hello" });
      expect(byId.map((t) => t.id)).toEqual(["skills.demo.hello"]);
    }),
  );

  it.effect("invoking a skill returns its markdown body verbatim", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [skillsPlugin({ skills: sampleSkills })] as const,
        }),
      );

      const body = yield* executor.tools.invoke("skills.demo.hello", {});
      expect(body).toBe("# Hello\n\nThis is the hello skill body.");
    }),
  );

  it.effect("skill handlers take no input (empty object schema)", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [skillsPlugin({ skills: sampleSkills })] as const,
        }),
      );

      const schema = yield* executor.tools.schema("skills.demo.hello");
      expect(schema?.inputSchema).toEqual({
        type: "object",
        properties: {},
        additionalProperties: false,
      });
    }),
  );

  it.effect("plugin works when no skills are registered", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [skillsPlugin()] as const }),
      );

      const tools = yield* executor.tools.list({ sourceId: "skills" });
      expect(tools).toEqual([]);
    }),
  );
});

describe("skillsPlugin — registration errors", () => {
  it("rejects duplicate skill ids at plugin construction time", () => {
    expect(() =>
      skillsPlugin({
        skills: [
          { id: "dup", description: "a", body: "first" },
          { id: "dup", description: "b", body: "second" },
        ],
      }),
    ).toThrow(/Duplicate skill id: dup/);
  });
});

describe("skillsPlugin — extension surface", () => {
  it.effect("exposes the raw skill list via executor.skills.skills", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [skillsPlugin({ skills: sampleSkills })] as const,
        }),
      );

      expect(executor.skills.skills).toEqual(sampleSkills);
    }),
  );
});
