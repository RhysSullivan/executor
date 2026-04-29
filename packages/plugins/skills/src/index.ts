import { Effect } from "effect";

import { definePlugin, type StaticToolDecl } from "@executor/sdk";

// A Skill is a named markdown document surfaced through the tool catalog.
// There is no new agent-facing primitive: the plugin registers each skill
// as a static tool whose handler returns the body. Discovery is
// `executor.tools.list({ query })`, loading is `executor.tools.invoke(id)`.
export interface Skill {
  /** Tool-name segment. The full tool id becomes `skills.<id>`. Dots are
   *  allowed and render nicely under `executor call skills ...`. */
  readonly id: string;
  /** One-line human summary. Indexed by `tools.list({ query })` together
   *  with the tool name. Kept as-is; the plugin prefixes `Skill: ` when
   *  registering so results stand out in the tool list. */
  readonly description: string;
  /** Markdown body returned verbatim from the tool handler. */
  readonly body: string;
}

export interface SkillsPluginOptions {
  readonly skills?: readonly Skill[];
}

const SKILL_DESCRIPTION_PREFIX = "Skill: ";

// Shared by the global plugin below AND by plugins that want to ship
// skills alongside their own tools — see `openApiPlugin` for an
// example. Exported so every skill has identical on-the-wire shape:
// `Skill:` prefix, empty-object input schema, handler that returns the
// markdown body. When MCP's Skills Extension SEP stabilizes we'll
// replace this with a dedicated StaticSkillDecl (see notes/skills.md),
// and the only callers to update are the ones that use this helper.
export const toStaticSkill = (skill: Skill): StaticToolDecl => ({
  name: skill.id,
  description: `${SKILL_DESCRIPTION_PREFIX}${skill.description}`,
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  handler: () => Effect.succeed(skill.body),
});

export const skillsPlugin = definePlugin(
  (options?: SkillsPluginOptions) => {
    const skills = options?.skills ?? [];
    // Duplicate-id check mirrors the core executor's staticTools collision
    // check — catching it here yields a pointer to the skill list instead
    // of the generic "Duplicate static tool id" error at executor startup.
    const seen = new Set<string>();
    for (const skill of skills) {
      if (seen.has(skill.id)) {
        throw new Error(`Duplicate skill id: ${skill.id}`);
      }
      seen.add(skill.id);
    }

    return {
      id: "skills" as const,
      storage: () => ({}),
      extension: () => ({
        /** Raw skill list as registered. Handy for tests and for hosts
         *  that want to render skills with richer UI than the generic
         *  tool list. */
        skills,
      }),
      staticSources: () => [
        {
          id: "skills",
          kind: "control",
          name: "Skills",
          tools: skills.map(toStaticSkill),
        },
      ],
    };
  },
);
