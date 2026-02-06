# OpenAssistant Plugin Architecture

## Status: Planning Draft

## Problem Statement

Today, tools are hardcoded in `apps/discord-bot/src/tools.ts`. The `defineTool()` API exists in `@openassistant/core` and works well, but there is no way for users to:

1. Define their own tools outside the monorepo source.
2. Install third-party tool packages.
3. Discover tools from a workspace/config directory.
4. Get type declarations auto-generated for the codemode typechecker.

We need a plugin system that makes tools **installable, discoverable, and configurable** while keeping the core primitives (receipts, approval, sandboxed execution) intact.

---

## Reference Analysis

We studied two production systems before designing this:

### OpenCode (`.reference/opencode/`)

OpenCode's approach is the primary inspiration. Key patterns worth adopting:

1. **Convention directories**: `.opencode/tool/`, `.opencode/plugin/`, `.opencode/skill/` — drop a `.ts` file in and it just works. No manifest file needed for simple tools.
2. **Auto-dependency management**: When `.opencode/` contains tools or plugins, OpenCode auto-generates a `package.json` with `@opencode-ai/plugin` and runs `bun install`. Zero friction.
3. **Plugin = function that returns hooks**: `Plugin = (input: PluginInput) => Promise<Hooks>`. Clean, no class ceremony.
4. **Tool definition via SDK**: `tool({ description, args: z.object({...}), execute(args) })` — zod schema inline, description as a string. Simple.
5. **File naming = tool ID**: Default export of `github-pr-search.ts` becomes tool `github-pr-search`. Named exports become `filename_exportname`.
6. **Multiple config sources**: Global (`~/.config/opencode/`), home (`~/.opencode/`), project (`.opencode/`), remote (`.well-known/opencode`). Deep merge with priority ordering.
7. **Bun-native loading**: Uses `import()` directly (Bun handles TypeScript). Also uses `Bun.Glob` for file discovery.
8. **Skills as Markdown**: `SKILL.md` files with YAML frontmatter. Separate from tools — skills are context/instructions, tools are callable functions.

### OpenClaw (`.context/openclaw/`)

More complex but some patterns worth noting:

1. **jiti for TypeScript loading**: Works across Node and Bun, handles SDK aliasing at import time.
2. **Plugin manifest (`openclaw.plugin.json`)**: JSON Schema for config validation without executing plugin code.
3. **Layered precedence**: Config > Workspace > Global > Bundled, with first-match-wins deduplication.
4. **Registration API pattern**: `register(api)` where `api.registerTool()`, `api.registerHook()`, etc. Very extensible but heavyweight for MVP.

### What We're Taking

From OpenCode:
- Convention directories (`.openassistant/tools/`, `.openassistant/plugins/`)
- File-as-tool pattern (drop `.ts` in `tools/`, it just works)
- Bun-native `import()` for module loading
- Zod schemas on tool definitions (args + description)
- Auto-dependency management for `.openassistant/` directories
- Simple plugin function pattern

From OpenClaw:
- Plugin manifest for config schema validation (but optional, not required)
- Config interpolation (`${ENV_VAR}`) for secrets

Avoiding from both:
- OpenClaw's heavyweight registration API (too many `registerX()` methods for MVP)
- Over-engineered config merging (keep it simple: project > global)

---

## Design Principles

1. **Convention over configuration.** Drop a `.ts` file in `tools/`, it becomes a tool. No manifest needed for simple cases.
2. **Config when you need it.** Full plugins with config schemas exist for complex integrations, but aren't required.
3. **Tools are the plugin unit.** MVP plugins = tool packages. Hooks, channels, services come later.
4. **TypeScript-native.** Bun loads `.ts` directly. No build step. No jiti (Bun-only for MVP).
5. **Monorepo-friendly.** Works whether your tool is a file in `.openassistant/tools/`, a workspace package, or an npm install.
6. **Zod schemas are the contract.** Input schemas enable type declaration generation, validation, and documentation — all from one source.
7. **Effect is an internal.** Tool authors never see Effect. The `run` function is a plain `async` function. The core runtime wraps it in Effect internally.
8. **Approval is the only policy knob.** No `kind`/`risk`/`type` classification. The tool author says `"auto"` or `"required"`. Operators can override via config.

---

## `defineTool()` — The Only API

There's one function to define a tool: `defineTool()`. No tiers, no `tool()` vs `defineTool()` split.

```ts
import { defineTool, z } from "@openassistant/sdk";

export default defineTool({
  description: "Get current weather for a location",
  approval: "auto",
  args: z.object({
    location: z.string().describe("City name or coordinates"),
  }),
  run: async (input) => {
    const res = await fetch(`https://wttr.in/${input.location}?format=j1`);
    return res.json();
  },
});
```

That's it. `run` is an async function. No Effect. No special return types. Throw to fail, return to succeed.

### Full Signature

```ts
function defineTool<TArgs extends z.ZodRawShape>(options: {
  /** Human description of what this tool does (shown to the LLM) */
  description: string;
  /** Whether the tool auto-runs or requires human approval before execution */
  approval: "auto" | "required";
  /** Zod schema for the input arguments */
  args: z.ZodObject<TArgs>;
  /** The tool implementation. Just an async function. */
  run: (input: z.infer<z.ZodObject<TArgs>>) => Promise<unknown>;
  /** Optional: format the input for the approval UI / receipt preview */
  previewInput?: (input: z.infer<z.ZodObject<TArgs>>) => string;
  /** Optional: format the output for the receipt preview */
  previewOutput?: (output: unknown) => string;
}): ToolDefinition
```

`approval` is the only field that controls execution policy at the tool level. There's no `kind` / `risk` classification — the tool author decides whether their tool needs human sign-off or not. Operators can override this via config/policy later (force approval on auto tools, auto-approve required tools for trusted contexts, deny tools entirely).

### What Happens Internally

The core runner (`packages/core/src/codemode/runner.ts`) wraps the plain async `run` function in Effect at materialization time — in `createToolInvoker()`. Plugin authors never know or care.

```ts
// Inside createToolInvoker (core internal):
const execution = await Effect.runPromiseExit(
  Effect.tryPromise(() => definition.run(validatedInput))
);
```

The current `defineTool()` in core takes `run: (input) => Effect.Effect<T, E>`. That signature changes to `run: (input) => Promise<T>`. The core runner wraps it. The existing `tools.ts` in discord-bot updates accordingly (just remove the `Effect.sync()` / `Effect.tryPromise()` wrappers from tool definitions).

### Before and After

**Before** (current `apps/discord-bot/src/tools.ts`):
```ts
import { defineTool } from "@openassistant/core";
import { Effect } from "effect";

defineTool({
  kind: "write",
  approval: "required",
  run: (input: { title: string; startsAt: string }) =>
    Effect.sync(() => calendarStore.update(input)),  // Effect leaks into authoring
  previewInput: (input) => `${input.title} @ ${input.startsAt}`,
});
```

**After** (new API):
```ts
import { defineTool, z } from "@openassistant/sdk";

defineTool({
  description: "Update a calendar event",
  approval: "required",
  args: z.object({
    title: z.string(),
    startsAt: z.string(),
    notes: z.string().optional(),
  }),
  run: async (input) => calendarStore.update(input),
  previewInput: (input) => `${input.title} @ ${input.startsAt}`,
});
```

Effect is gone from the authoring surface. `kind` is gone — `approval` is the only policy field. The `args` zod schema replaces the inline TypeScript type annotation on `run`'s parameter. `description` is now required.

---

## Where `defineTool()` Lives

Two packages, two roles:

| Package | Role | Contains |
|---------|------|----------|
| `packages/core` | **Runtime engine** | `ToolDefinition` type, `createCodeModeRunner()`, materialization, receipts, approval flow. Effect lives here. |
| `packages/sdk` | **Authoring surface** | `defineTool()` function, `z` re-export, `PluginContext` type. This is what plugin authors import. No Effect. |

The SDK's `defineTool()` creates a `ToolDefinition` object (with `_tag: "ToolDefinition"`). The core runtime consumes it. The SDK doesn't import Effect at all — it's a thin layer that produces the right shape.

```ts
// packages/sdk/src/define-tool.ts
import { z } from "zod";

export interface ToolDefinition {
  readonly _tag: "ToolDefinition";
  readonly description: string;
  readonly approval: "auto" | "required";
  readonly args: z.ZodObject<any>;
  readonly run: (input: unknown) => Promise<unknown>;
  readonly previewInput?: (input: any) => string;
  readonly previewOutput?: (output: unknown) => string;
}

export function defineTool<TArgs extends z.ZodRawShape>(options: {
  description: string;
  approval: "auto" | "required";
  args: z.ZodObject<TArgs>;
  run: (input: z.infer<z.ZodObject<TArgs>>) => Promise<unknown>;
  previewInput?: (input: z.infer<z.ZodObject<TArgs>>) => string;
  previewOutput?: (output: unknown) => string;
}): ToolDefinition {
  return {
    _tag: "ToolDefinition",
    description: options.description,
    approval: options.approval,
    args: options.args,
    run: options.run,
    previewInput: options.previewInput,
    previewOutput: options.previewOutput,
  };
}
```

The core's `createToolInvoker()` then does:
1. Parse input through `definition.args` (zod validation)
2. Call `definition.run(validatedInput)` 
3. Wrap in Effect for receipt tracking, approval flow, etc.

---

## Standalone Tools vs Full Plugins

### Standalone Tools (Zero Friction)

A tool is a single `.ts` file in a convention directory. No `package.json`, no manifest.

```
.openassistant/
  tools/
    weather.ts
    github-issues.ts
```

**`weather.ts`**:
```ts
import { defineTool, z } from "@openassistant/sdk";

export default defineTool({
  description: "Get current weather for a location",
  approval: "auto",
  args: z.object({
    location: z.string().describe("City name or coordinates"),
  }),
  run: async (input) => {
    const res = await fetch(`https://wttr.in/${input.location}?format=j1`);
    return res.json();
  },
});
```

Rules:
- **Default export** → tool ID = filename without extension (`weather`)
- **Named exports** → tool ID = `filename.exportName` (`github_issues.list`)

### Full Plugins (Config + Multiple Tools + Dependencies)

A plugin is a directory with `package.json` (has `"openassistant"` key) and optionally `openassistant.json` for config schema.

```
.openassistant/
  plugins/
    posthog/
      package.json
      openassistant.json     # Optional: config schema
      index.ts
```

Or as an npm package:
```bash
bun add @openassistant/plugin-posthog
```

**`package.json`** (minimal):
```json
{
  "name": "@myorg/oa-posthog",
  "type": "module",
  "dependencies": {
    "posthog-node": "^4.0.0"
  },
  "peerDependencies": {
    "@openassistant/sdk": "*"
  },
  "openassistant": {
    "entry": "./index.ts"
  }
}
```

**`openassistant.json`** (optional, for config validation):
```json
{
  "id": "posthog",
  "name": "PostHog Analytics",
  "description": "Read analytics and create monitors via PostHog API.",
  "configSchema": {
    "type": "object",
    "required": ["apiKey", "projectId"],
    "properties": {
      "apiKey": { "type": "string" },
      "projectId": { "type": "string" },
      "host": { "type": "string", "default": "https://us.posthog.com" }
    },
    "additionalProperties": false
  }
}
```

**`index.ts`** (plugin entry):
```ts
import { defineTool, z, type PluginContext, type ToolTree } from "@openassistant/sdk";
import { PostHogClient } from "posthog-node";

export default function register(ctx: PluginContext): ToolTree {
  const client = new PostHogClient(ctx.config.apiKey as string);

  return {
    analytics: {
      getVisitors: defineTool({
        description: "Get visitor count for a website",
        approval: "auto",
        args: z.object({ website: z.string() }),
        run: async (input) => client.getInsight(input.website),
      }),
    },
    monitor: {
      createThreshold: defineTool({
        description: "Create a threshold alert for visitor count",
        approval: "required",
        args: z.object({ website: z.string(), threshold: z.number() }),
        run: async (input) => client.createAlert(input),
      }),
    },
  };
}
```

Same `defineTool()`, same API. The only difference is the plugin exports a function that receives config via `PluginContext`, instead of exporting tools directly.

---

## Config File

### Location Resolution

Config is found by scanning these locations (higher priority wins):

| Priority | Location | Env Override |
|----------|----------|--------------|
| 1 (highest) | `OPENASSISTANT_CONFIG` env var (path to file) | — |
| 2 | `<project>/.openassistant/config.json` | — |
| 3 (lowest) | `~/.config/openassistant/config.json` | `OPENASSISTANT_CONFIG_DIR` |

Project root is detected by walking up from cwd looking for `.openassistant/` directory or `package.json`.

When both project and global exist, they're deep-merged (project overrides global).

### Config Shape

```jsonc
{
  // Plugin specifiers — npm packages or file:// URLs
  "plugins": [
    "@openassistant/plugin-posthog",
    "@openassistant/plugin-github@^0.2.0",
    "file:///absolute/path/to/plugin",
    "./relative/path/to/plugin"
  ],

  // Per-plugin configuration
  "config": {
    "posthog": {
      "enabled": true,
      "apiKey": "${POSTHOG_API_KEY}",
      "projectId": "12345",
      "host": "https://us.posthog.com"
    },
    "github": {
      "enabled": true,
      "token": "${GITHUB_TOKEN}"
    }
  },

  // Auth profiles
  "auth": {
    "anthropic": {
      "type": "token",
      "profileOrder": ["manual", "env"]
    }
  },

  // Tool-level overrides
  "tools": {
    "weather": true,            // enable (default)
    "dangerous-tool": false     // disable
  }
}
```

- **`plugins` is a flat array** (like OpenCode). The loader auto-detects whether a specifier is an npm package, a path, or a URL.
- **`config` is top-level**, keyed by plugin ID.
- **`tools` is a simple enable/disable map.** Individual tools can be toggled without touching plugin config.
- **`${ENV_VAR}` interpolation** for secrets. Only in string values. No shell expansion.

---

## Discovery and Loading

### Convention Directories

These directories are auto-scanned for tools and plugins:

| Directory | What's Scanned |
|-----------|----------------|
| `<project>/.openassistant/tools/` | Standalone `.ts`/`.js` files |
| `<project>/.openassistant/plugins/` | Plugin directories with `package.json` |
| `~/.config/openassistant/tools/` | Global standalone tools |
| `~/.config/openassistant/plugins/` | Global plugin directories |

### Auto-Dependency Management

When the `.openassistant/` directory contains tools or plugins, the loader:

1. Checks for `package.json` in `.openassistant/`.
2. If missing, creates one with `@openassistant/sdk` as a dependency.
3. Runs `bun install` if `node_modules` doesn't exist or `@openassistant/sdk` is missing.

Users can just drop a `.ts` file in `tools/` and it works — the SDK dependency is auto-managed.

```json
// Auto-generated .openassistant/package.json
{
  "private": true,
  "type": "module",
  "dependencies": {
    "@openassistant/sdk": "^0.1.0"
  }
}
```

### Full Pipeline

```
1. RESOLVE CONFIG
   - Find config file (env > project > global)
   - Parse JSONC with ${ENV_VAR} interpolation
   - Deep merge if multiple sources

2. SCAN CONVENTION DIRECTORIES
   - .openassistant/tools/*.{ts,js} → standalone tool candidates
   - .openassistant/plugins/*/ → plugin candidates (must have package.json)
   - Same for global ~/.config/openassistant/

3. RESOLVE PLUGIN SPECIFIERS
   - For each entry in config.plugins[]:
     a. npm package name → resolve from node_modules
     b. file:// URL → resolve absolute path
     c. Relative path → resolve from project root

4. AUTO-INSTALL DEPENDENCIES
   - Ensure .openassistant/package.json exists with SDK dep
   - Run bun install if needed

5. DEDUPLICATE
   - By plugin ID (from manifest) or tool filename
   - First-found wins (project > global > npm > bundled)

6. LOAD MODULES
   - Use dynamic import() (Bun handles .ts natively)
   - For standalone tools: import file, extract default + named exports
   - For plugins: import entry, resolve function vs ToolTree export

7. VALIDATE CONFIG
   - If plugin has openassistant.json with configSchema:
     validate config[pluginId] against JSON Schema
   - Skip with warning on validation failure

8. VALIDATE INPUTS (at tool definition time)
   - Each tool has a zod args schema
   - At invocation time, parse input through schema before calling run

9. BUILD TOOL TREE
   - Standalone tools: flat under their filename ID
   - Plugin tools: namespaced under plugin ID
   - Check tools config for enable/disable overrides
   - Detect ID collisions (error)

10. GENERATE TYPE DECLARATIONS
    - Walk merged ToolTree
    - Derive TypeScript types from zod args schemas
    - This replaces the hardcoded TOOL_DECLARATIONS

11. READY
    - Pass merged ToolTree to createCodeModeRunner()
    - Pass declarations to typechecker
```

---

## The SDK Package (`@openassistant/sdk`)

New package: `packages/sdk/`. This is the **only** package tool authors need. No Effect, no core internals.

### Exports

```ts
// packages/sdk/src/index.ts
export { defineTool, type ToolDefinition, type ToolTree } from "./define-tool.js";
export type { PluginContext } from "./plugin-context.js";
export { z } from "zod";
```

That's it. Three things: `defineTool`, `PluginContext`, `z`.

### What the SDK does NOT export

- `Effect` — internal to core runtime
- `ToolCallReceipt` — internal to core runtime
- `ApprovalRequest` — internal to core runtime
- `createCodeModeRunner` — internal to core runtime

---

## Changes to Core

### `ToolDefinition` (the shape)

The `ToolDefinition` interface changes from Effect-based to plain async, and drops `kind`:

```ts
// packages/core — BEFORE
export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  readonly _tag: "ToolDefinition";
  readonly kind: ToolKind;               // "read" | "write"
  readonly approval: ToolApprovalMode;   // "auto" | "required"
  readonly run: (input: TInput) => Effect.Effect<TOutput, unknown>;
  readonly previewInput?: (input: TInput) => string | undefined;
  readonly previewOutput?: (output: TOutput) => string | undefined;
}

// packages/core — AFTER
export interface ToolDefinition {
  readonly _tag: "ToolDefinition";
  readonly description: string;
  readonly approval: "auto" | "required";
  readonly args: z.ZodObject<any>;
  readonly run: (input: unknown) => Promise<unknown>;
  readonly previewInput?: (input: any) => string | undefined;
  readonly previewOutput?: (output: unknown) => string | undefined;
}
```

Changes:
1. `run` returns `Promise<unknown>` instead of `Effect.Effect<TOutput, unknown>`
2. `kind` removed — `approval` is the only policy field
3. `args` (zod schema) added — required
4. `description` added — required
5. Generic type parameters removed (zod handles type safety at the authoring site, core treats everything as `unknown` internally)

### `createToolInvoker()` (the runtime)

The invoker validates input via zod, then wraps the plain async `run` in Effect:

```ts
// BEFORE: runs Effect directly, no input validation
const execution = await Effect.runPromiseExit(params.definition.run(input));

// AFTER: validates with zod, wraps async function in Effect
const validated = params.definition.args.safeParse(input);
if (!validated.success) {
  // emit failed receipt with validation error, throw
}
const execution = await Effect.runPromiseExit(
  Effect.tryPromise(() => params.definition.run(validated.data))
);
```

### `createCodeModeRunner()` (unchanged API)

The runner still takes a `ToolTree` and a `requestApproval` callback. Still returns an Effect. The public contract of the runner doesn't change — only the internal `ToolDefinition` shape does.

### Migration of existing tools

`apps/discord-bot/src/tools.ts` drops Effect imports and uses the new API:

```ts
// BEFORE
import { defineTool } from "@openassistant/core";
import { Effect } from "effect";

calendar: {
  update: defineTool({
    kind: "write",
    approval: "required",
    run: (input: { title: string; startsAt: string }) =>
      Effect.sync(() => calendarStore.update(input)),
  }),
}

// AFTER
import { defineTool, z } from "@openassistant/sdk";

calendar: {
  update: defineTool({
    description: "Create or update a calendar event",
    approval: "required",
    args: z.object({
      title: z.string(),
      startsAt: z.string(),
      notes: z.string().optional(),
    }),
    run: async (input) => calendarStore.update(input),
  }),
}
```

### Migration of `ToolCallReceipt`

The `kind` field is also removed from `ToolCallReceipt`. Receipts track `approval` mode and `decision` — that's sufficient. The receipt shape becomes:

```ts
export interface ToolCallReceipt {
  callId: string;
  toolPath: string;
  approval: "auto" | "required";
  decision: "auto" | "approved" | "denied";
  status: "succeeded" | "failed" | "denied";
  timestamp: string;
  inputPreview?: string;
  outputPreview?: string;
  error?: string;
}
```

---

## Type Declaration Generation

### The Problem

`code-typecheck.ts` currently has a hardcoded `TOOL_DECLARATIONS` string. When tools are dynamically loaded, we need to generate this.

### Approach: Derive from Zod Schemas

Every tool now has a zod `args` schema. We walk the merged ToolTree, convert each schema to a TypeScript type string, and emit ambient declarations.

```ts
// Given:
defineTool({
  description: "Get weather",
  approval: "auto",
  args: z.object({
    location: z.string(),
    units: z.enum(["metric", "imperial"]).default("metric"),
  }),
  run: async (args) => { ... },
});

// Generates:
// weather(input: { location: string; units?: "metric" | "imperial" }): Promise<unknown>
```

For the full merged tree:
```ts
declare const tools: {
  weather(input: { location: string; units?: "metric" | "imperial" }): Promise<unknown>;
  posthog: {
    analytics: {
      getVisitors(input: { website: string }): Promise<unknown>;
    };
    monitor: {
      createThreshold(input: { website: string; threshold: number }): Promise<unknown>;
    };
  };
};
```

---

## Monorepo User Experience

### Scenario 1: Quick tool (30 seconds to working)

```bash
mkdir -p .openassistant/tools
```

Create `.openassistant/tools/weather.ts`:
```ts
import { defineTool, z } from "@openassistant/sdk";

export default defineTool({
  description: "Get current weather",
  approval: "auto",
  args: z.object({ location: z.string() }),
  run: async ({ location }) => {
    const res = await fetch(`https://wttr.in/${location}?format=j1`);
    return res.json();
  },
});
```

Done. OpenAssistant auto-creates `package.json`, installs SDK, discovers the tool.

### Scenario 2: Workspace package plugin

```
my-project/
  .openassistant/
    config.json
  packages/
    oa-posthog/
      package.json          # has "openassistant" key
      openassistant.json    # config schema
      index.ts
```

`.openassistant/config.json`:
```jsonc
{
  "plugins": ["./packages/oa-posthog"],
  "config": {
    "posthog": {
      "apiKey": "${POSTHOG_API_KEY}",
      "projectId": "12345"
    }
  }
}
```

### Scenario 3: npm package

```bash
bun add @openassistant/plugin-github
```

`.openassistant/config.json`:
```jsonc
{
  "plugins": ["@openassistant/plugin-github"],
  "config": {
    "github": { "token": "${GITHUB_TOKEN}" }
  }
}
```

### Scenario 4: Multiple tools in one file

`.openassistant/tools/github-issues.ts`:
```ts
import { defineTool, z } from "@openassistant/sdk";

export const list = defineTool({
  description: "List GitHub issues",
  approval: "auto",
  args: z.object({
    repo: z.string(),
    state: z.enum(["open", "closed"]).default("open"),
  }),
  run: async ({ repo, state }) => { ... },
});

export const create = defineTool({
  description: "Create a GitHub issue",
  approval: "required",
  args: z.object({
    repo: z.string(),
    title: z.string(),
    body: z.string().optional(),
  }),
  run: async ({ repo, title, body }) => { ... },
});
```

Tools become: `tools.github_issues.list(...)` and `tools.github_issues.create(...)`.

---

## Implementation Plan

### Phase 1: New `defineTool()` + SDK

1. **Change `ToolDefinition` in core** — `run` becomes `Promise`, drop `kind`, add `args` + `description`
2. **Update `createToolInvoker()`** — wrap async `run` in Effect internally, add zod validation
3. **Update `ToolCallReceipt`** — drop `kind` field
4. **Create `packages/sdk/`** — `defineTool()`, `z` re-export, `PluginContext` type
5. **Migrate `apps/discord-bot/src/tools.ts`** — use new API, drop Effect
6. **Type declaration generator** — walk ToolTree, emit declarations from zod schemas

### Phase 2: Config + Discovery

6. **Config loader** (`packages/core/src/config/`)
   - Config file resolution (env > project > global)
   - JSONC parsing + `${ENV_VAR}` interpolation
   - Zod schema for config shape validation

7. **Tool/Plugin discovery** (`packages/core/src/plugins/`)
   - Scan convention directories (`tools/`, `plugins/`)
   - Resolve plugin specifiers (npm, file://, relative path)
   - Auto-dependency management for `.openassistant/`
   - Deduplicate by ID

8. **Plugin loader** (`packages/core/src/plugins/loader.ts`)
   - Dynamic `import()` for `.ts` files
   - Resolve export pattern (function vs ToolTree vs individual tools)
   - Config validation against manifest schema
   - Build merged ToolTree + declarations

### Phase 3: Wire Into Runtime

9. **Update `apps/discord-bot/`** — use plugin registry instead of hardcoded tools
10. **Update `apps/gateway/`** — same

### Phase 4: DX Polish

11. **`openassistant init`** — scaffold `.openassistant/config.json`
12. **`openassistant tools create <name>`** — scaffold a tool file
13. **`openassistant plugins list`** — show discovered tools/plugins and their status

---

## Key Decisions (Resolved)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Tool authoring API | Plain async `run` function | Effect is a runtime internal. Tool authors shouldn't know it exists. |
| Tool policy | `approval: "auto" \| "required"` only | No `kind`/`risk` classification. Tool author sets approval default. Operators can override via config. |
| Module loading | Bun native `import()` | We're Bun-only. Zero deps. Bun handles .ts natively. |
| Config format | JSONC | Comments are essential for config files. |
| Config location | `.openassistant/config.json` | Follows OpenCode's `.opencode/` pattern. |
| Plugin specifiers | Flat array (like OpenCode) | Simpler than `{ paths, npm }`. Auto-detect type from specifier. |
| Tool schemas | Required zod `args` on every tool | Enables type declaration gen, validation, and docs from one source. |
| Namespacing | Plugin ID from manifest or dirname | Plugin tools namespaced automatically. Standalone tools are flat. |
| Hot reload | No (MVP) | Bun `--hot` covers dev. True registry reload is Phase 2+. |
| SDK package | Separate (`packages/sdk/`) | Clean boundary. No Effect dependency for tool authors. |

---

## Security Considerations

1. **Plugins run in the same process.** No sandbox between plugins and the gateway. The sandbox boundary is between LLM-generated code and tool implementations, not between plugins.

2. **Config interpolation** only supports `${ENV_VAR}` syntax. No shell expansion, no nested interpolation, no code execution.

3. **Plugin code is trusted.** If a user puts a plugin in their config, they trust it. No malicious code scanning.

4. **Secrets in config** should use env var interpolation. We log a warning (not block) if literal API keys appear in config files.

---

## File Layout After Implementation

```
packages/
  core/
    src/
      index.ts
      codemode/
        runner.ts                 # UPDATED: ToolDefinition uses Promise, adds zod validation
        runner.test.ts
      config/
        loader.ts                 # NEW: config file resolution + parsing
        types.ts                  # NEW: config shape (Zod schema)
        interpolation.ts          # NEW: ${ENV_VAR} expansion
      plugins/
        discovery.ts              # NEW: scan convention dirs + resolve specifiers
        loader.ts                 # NEW: dynamic import + export resolution
        manifest.ts               # NEW: parse/validate openassistant.json
        registry.ts               # NEW: merge ToolTrees, deduplicate, enable/disable
        declarations.ts           # NEW: generate TypeScript declarations from zod schemas
        auto-install.ts           # NEW: auto-create package.json + bun install
        types.ts                  # NEW: DiscoveredPlugin, LoadedPlugin, etc.
  sdk/
    package.json                  # NEW: @openassistant/sdk
    src/
      index.ts                    # NEW: exports defineTool, z, PluginContext
      define-tool.ts              # NEW: defineTool() — creates ToolDefinition, no Effect
      plugin-context.ts           # NEW: PluginContext type
```

---

## Open Questions

1. **Do we validate tool inputs at runtime?**
   Yes. Parse input through zod schema before calling `run`. This catches bad LLM-generated inputs early with clear error messages in receipts.

2. **How do we handle tools that need persistent state?**
   `PluginContext.dataDir` gives plugins a persistent directory. Not needed for standalone tools in MVP.

3. **Should we support `openassistant.jsonc` (comments)?**
   Yes. Both `config.json` and `config.jsonc` should be accepted.
