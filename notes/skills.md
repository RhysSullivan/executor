# Skills

Skills are documentation for agents — a markdown body plus a name and a
description, loaded on demand instead of living in every system prompt.
The goal is progressive disclosure: agents search a catalog, pull the
skill they need, follow its instructions to chain tools.

## Where we are today

`@executor/plugin-skills` exposes skills as static tools whose handler
returns the body. Discovery goes through the normal
`tools.list({ query })`; loading goes through `tools.invoke(id)`. No new
primitive. That shape is fine as a v1 because it costs nothing and is
forward-compatible with every client that speaks tools.

The naming-as-attachment convention (skill id `<plugin>.<slug>`,
description prefixed `Skill:`) made substring queries land the skill
next to related real tools. It's a stopgap — a real attachment point
arrives when skills move off the global plugin (below).

## The tension the convention was papering over

Global skills and per-source skills are different concepts. Today the
plugin lumps both into one flat source id `skills`. But `openapi.adding-
a-source` is semantically owned by the openapi source — it describes
that source's tools. It should live under the same source id as the
tools it documents, so `tools.list({ sourceId: "openapi" })` returns
its own documentation alongside its operations.

The per-source case will also dominate in practice. Anyone shipping a
Cloudflare / Linear / Stripe integration will ship skills alongside
their tools, not in a shared global bucket. MCP is standardizing on
exactly this.

## What MCP is doing

The first-class-primitive draft (SEP-2076: `skills/list`, `skills/get`)
was **closed 2026-02-24**. Author pivoted to the alternative. The live
direction is maintained by the Skills Over MCP Working Group (promoted
from Interest Group on 2026-04-16, charter
[here](https://modelcontextprotocol.io/community/skills-over-mcp/charter)).
Their docs are mirrored in `.references/experimental-ext-skills/`.

Accepted decisions so far:

- **Skills are Resources, not a new primitive.** Discovery via the
  existing `resources/list`. Addressable URIs, not opaque names.
- **URI scheme is `skill://<skill-path>/SKILL.md`.** Sub-resources
  (reference docs, examples) are siblings under the same path. Four
  independent implementations converged on `skill://` before the WG
  formalized it — NimbleBrain, skilljack-mcp, skills-over-mcp,
  FastMCP 3.0.
- **Name and path are decoupled.** The path locates; the
  `SKILL.md` frontmatter `name` identifies. A skill at
  `skill://acme/billing/refunds/SKILL.md` can be named `refund-
  handling` in its frontmatter.
- **Instructor format only.** Markdown content, not executable code.
  Skills that need to execute local code use existing distribution
  mechanisms (npx, repos) and are explicitly out of scope for
  MCP-served skills.
- **Skill semantics live in frontmatter.** `version`, `allowed-tools`,
  `invocation` — all in SKILL.md YAML, not in MCP `_meta`. `_meta` is
  reserved for transport-specific concerns with no natural home
  elsewhere.
- **Clients get a helper for loading.** Rather than every server
  shipping a `load_skill` tool, clients get a built-in `read_resource`
  affordance or SDK-level `list_skill_uris()`.

This informs our SDK design because our static-tool system is
effectively in-process MCP. Whatever shape MCP lands on, ours should
match 1:1 so the MCP-source adapter passes skills through without
translation.

## Short-term move

Keep skills-as-tools internally (no churn), but stop flattening
per-source skills into the global `skills` source:

1. Each plugin that ships skills owns them. `openapiSkills` moves from
   "exported from `@executor/plugin-openapi` to be re-wired in
   `apps/local`" to "registered directly by the openapi plugin in its
   own `staticSources`."
2. `@executor/plugin-skills` exports a small `toStaticSkill(skill):
   StaticToolDecl` helper — three lines of shared code so plugins don't
   reimplement the `Skill:` prefix + empty schema + `Effect.succeed(body)`
   boilerplate.
3. `skillsPlugin({ skills: [...] })` stays wired in `apps/local` as the
   home for **cross-cutting / user-authored** skills that don't belong
   to any specific source. Today it's empty.

After the move, `tools.list({ sourceId: "openapi" })` returns
`openapi.previewSpec`, `openapi.addSource`, `openapi.adding-a-source` —
the skill is literally next to the tools, without relying on substring
search ranking. The naming-as-attachment convention becomes a natural
consequence of the sourceId, not a convention.

## Longer-term refactor (deferred until SEP stabilizes)

Grow `StaticSource` to carry a sibling `skills` field next to `tools`:

```ts
interface StaticSource {
  id: string;
  name: string;
  kind: "control" | "data";
  tools: StaticToolDecl[];
  skills?: StaticSkillDecl[]; // future
}
```

`StaticSkillDecl` shape tracks the WG's output — at minimum URI
(`skill://<source-id>/<path>/SKILL.md`), frontmatter (name,
description, version, allowed-tools), body. The MCP-source adapter
converts `resources/list` filtered to `skill://` into
`StaticSkillDecl[]` 1:1. Our own plugins declare them directly.

At that point the `skillsPlugin` becomes "a plugin that exposes one
static source whose `skills` array is user-authored" — not a special
concept, just another source.

Not building this now because:

- The Skills Extension SEP is still in active drafting (WG formed
  four days ago as of writing).
- Sub-resource URI shape is still being refined (see
  `.references/experimental-ext-skills/skill-uri-scheme.md` PR notes
  about multi-segment paths and path-name decoupling).
- We don't have a Resources system in core today. Adding one to track
  a moving SEP is bad timing.

When the SEP lands: rename "static tool with markdown body" →
"static skill," add the URI, thread it through the MCP adapter. The
attachment point is already correct by then, so it's a shape change
inside the same place.

## Secret capture is still open

The openapi skill currently forbids the agent from accepting secret
values in chat (see `packages/plugins/openapi/src/sdk/skills.ts`). The
user provisions values out of band. That's the safe rule, but it
leaves the UX half-built — we don't have a first-class "ask the user
for a secret, route it past the model" flow. MCP elicitation gives us
a mechanism but the UI wiring hasn't been done. Worth its own note
when we get there.
