# executor


https://github.com/user-attachments/assets/11225f83-e848-42ba-99b2-a993bcc88dad


`executor` is a local-first execution environment for AI agents.

It gives an agent a TypeScript runtime, a discoverable tool catalog, and a single local place to connect external systems such as MCP servers, OpenAPI APIs, and GraphQL APIs. Instead of pasting large MCP manifests into every chat or giving an agent broad shell access, you run code inside `executor` and let it call typed `tools.*` functions.

## Community

Join the Discord community: https://discord.gg/eF29HBHwM6

At runtime, `executor` behaves like one local product:

- a CLI for starting the runtime and executing code
- a local API server
- a local web UI for connecting sources, inspecting tools, and managing secrets
- an MCP endpoint for hosts that want to drive `executor` through MCP

The current codebase lives in `apps/` and `packages/`. Older experiments stay in `legacy/` and `legacy2/`.

## Attribution

- [Crystian](https://www.linkedin.com/in/crystian/) provided the npm package name `executor`.
- The `codemode` concept in this project is inspired by Cloudflare's [Code Mode announcement](https://blog.cloudflare.com/code-mode/).

## Why this exists

`executor` is built around a simple idea: agents should work against a structured tool environment instead of guessing at raw HTTP calls, carrying huge MCP definitions in context, or running arbitrary local commands with broad permissions.

In practice that means:

- sources are connected once and turned into a reusable workspace tool catalog
- the agent discovers tools by intent, inspects schemas, and then calls typed functions
- secrets and OAuth flows stay in the local runtime and web UI instead of being pasted into chat
- human interaction can pause an execution and resume it cleanly

## Mental model

Think of `executor` as a local control plane for agent tool use.

1. You start a local `executor` daemon.
2. You connect sources such as an MCP server, an OpenAPI document, or a GraphQL endpoint.
3. `executor` indexes those sources into a workspace tool catalog.
4. An agent runs TypeScript against that catalog through `executor call` or through the MCP bridge.
5. If a tool needs credentials or user input, execution pauses, opens a local flow, and then resumes.

## What it does today

### Connect external tool sources

`executor` currently supports these source types:

- `mcp`: remote MCP servers, including transport selection for streamable HTTP or SSE
- `openapi`: REST APIs described by an OpenAPI document
- `graphql`: GraphQL endpoints that can be introspected into callable tools

The add-source flow can:

- probe a URL and infer what kind of source it is
- infer likely authentication requirements
- prompt for credentials when discovery or connection needs them
- start OAuth when a source requires it
- persist the source and its indexed tool metadata in the local workspace

The web app also includes templates for common providers so you can start from real examples instead of filling every field by hand.

### Run agent code against tools

The main CLI workflow is `executor call`.

The runtime expects the agent to use the built-in discovery workflow:

```ts
const matches = await tools.discover({ query: "github issues", limit: 5 });
const path = matches.bestPath;
const detail = await tools.describe.tool({ path, includeSchemas: true });

return await tools.github.issues.list({
  owner: "vercel",
  repo: "next.js",
});
```

A few important rules shape the execution model:

- write TypeScript, not raw shell pipelines
- use `tools.*`, not direct `fetch`
- discover first when the exact tool path is not known
- inspect schemas before calling complex tools

### Handle credentials and user interaction

When a source or tool needs human input, `executor` can pause the execution and create an interaction record.

That interaction may ask you to:

- open a secure local credential page
- complete an OAuth flow in the browser
- respond to a structured elicitation from a tool host
- resume a paused execution from the CLI

This is the core human-in-the-loop behavior that lets `executor` keep secrets and approvals outside the agent's raw context.

### Inspect the connected tool model

The web UI is not just a setup surface. It is also where you can inspect what `executor` learned from a source.

For each source you can:

- browse its tool tree
- search for tools by intent
- inspect input and output schemas
- view generated manifests, definitions, and raw source documents when available
- edit source settings and authentication details

## Quick start

If you want to use this a package distribution, install it via npm:

```bash
npm install -g executor
executor web
```

That starts a foreground local session, prints the local web URL, and keeps it alive until you press `Ctrl+C`.

If you want the MCP endpoint instead, run:

```bash
executor mcp
```

That prints the local MCP URL and keeps the session alive until you press `Ctrl+C`.

If you want a local stdio MCP server for agent configs such as Codex or OpenCode, run:

```bash
executor mcp --stdio
```

Then you can run the CLI as `executor`.

If you are working from this repository locally, the easiest path is:

```bash
bun install
bun dev
```

That starts the local runtime. The default base URL is:

```text
http://127.0.0.1:8788
```

From there:

1. Open the web UI in your browser.
2. Add a source from `/sources/add`.
3. If needed, store credentials in `/secrets`.
4. Run TypeScript with `bun run executor call ...`.

If you are using a packaged distribution, the command name is simply `executor` instead of `bun run executor`.

## Core CLI commands

```bash
executor web
executor mcp
executor mcp --stdio
executor call --file script.ts
executor resume --execution-id exec_123
```

Compatibility commands for the detached daemon are still available:

```bash
executor up
executor down
executor status --json
executor doctor --json
```

`executor call` accepts code in three ways:

- inline as a positional argument
- from `--file`
- from standard input with `--stdin`

Examples:

```bash
executor call 'const matches = await tools.discover({ query: "repo details", limit: 1 }); return matches;'
executor call --file script.ts
cat script.ts | executor call --stdin
executor call --no-open --file script.ts
```

If an execution pauses, resume it with:

```bash
executor resume --execution-id exec_123
```

## Adding a source

There are two main ways to add a source.

### In the web UI

Use the Add Source flow to:

- paste a URL
- run discovery
- review the inferred kind, namespace, transport, and auth
- connect the source
- complete credential or OAuth setup if required

This is the easiest path for most users.

### From inside an execution

The runtime also exposes `tools.executor.sources.add(...)`, which lets an agent add a source from code.

Examples:

```ts
return await tools.executor.sources.add({
  kind: "mcp",
  name: "Example",
  endpoint: "https://example.com/mcp",
  transport: "auto",
  queryParams: null,
  headers: null,
  command: null,
  args: null,
  env: null,
  cwd: null,
  auth: { kind: "none" },
});
```

```ts
return await tools.executor.sources.add({
  kind: "openapi",
  name: "GitHub",
  specUrl:
    "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json",
  baseUrl: null,
  auth: { kind: "none" },
});
```

`executor.sources.add(...)` accepts the final plugin-specific source config.
Browser OAuth and popup-driven auth flows live on the plugin-owned HTTP and web surfaces.

## How execution works

At a high level, every execution follows the same loop:

1. `executor` resolves the current local installation and workspace.
2. It builds a tool catalog from built-in tools plus all connected workspace sources.
3. It runs your TypeScript inside the configured sandbox runtime. QuickJS is the default, and `.executor/executor.jsonc` can set `"runtime": "quickjs" | "ses" | "deno"`.
4. Tool calls are dispatched through `executor` rather than directly from your code.
5. If a tool needs interaction, the run pauses and records a pending interaction.
6. Once the interaction is resolved, the execution continues and eventually completes or fails.

Example:

```jsonc
{
  "runtime": "ses",
  "sources": {}
}
```

This gives you a stable surface for agent automation:

- the agent sees a coherent catalog
- connected sources become reusable namespace-based tools
- auth stays attached to sources and secret material
- the runtime can track execution state instead of losing it inside a one-shot prompt

## Web UI overview

The React web app is served from the same local server as the API.

Main screens:

- `/`: list connected sources in the current local workspace
- `/sources/add`: discover and connect new sources
- `/sources/:sourceId`: inspect tools, search tools, and browse source artifacts
- `/sources/:sourceId/edit`: edit source settings and auth
- `/secrets`: create, update, and delete locally stored secrets

The UI uses the same control-plane API as the CLI, so both surfaces are operating on the same local runtime state.

## Local-first runtime behavior

By default `executor` runs as a single local daemon process.

It serves:

- `/v1` for the local control-plane API
- `/mcp` for the `executor` MCP endpoint
- the web UI for normal browser routes

Default network location:

- host: `127.0.0.1`
- port: `8788`

Default data locations are OS-aware:

- Linux data: `~/.local/share/executor`
- Linux runtime state: `~/.local/state/executor/run`
- macOS: `~/Library/Application Support/Executor`
- Windows: `%LOCALAPPDATA%\Executor`

The server also maintains local PID and log files in its runtime directory.

## Persistence and data

`executor` persists the local control plane to local files.

Persisted concepts include:

- local installation identity
- connected sources
- indexed tool artifacts and related metadata
- credentials and secret material bindings
- source auth sessions
- execution and interaction state
- executions and execution interactions
- policies

On first start, `executor` provisions a local account, a personal organization, and a default workspace automatically.

## Security and trust model

`executor` is designed to narrow how agents interact with external systems.

Compared with direct shell or raw API usage, the model is intentionally more structured:

- tool calls are routed through a controlled runtime
- secrets are stored separately from prompt text
- OAuth and credential capture happen through local flows
- executions can pause for interaction instead of guessing or failing silently
- source auth and tool metadata live with the workspace rather than inside each prompt

This does not make the system magically risk-free, but it gives the runtime places to enforce policy, collect approvals, and keep sensitive material out of the agent's immediate context.

## Repository layout

If you are exploring the repo, these are the directories that matter most:

- `apps/executor`: packaged CLI entrypoint and daemon lifecycle commands
- `apps/web`: local React web UI
- `packages/platform/server`: local HTTP server that serves API, MCP, and UI
- `packages/platform/sdk`: source management, secrets, persistence, execution, and inspection
- `packages/platform/api`: thin HTTP adapter over the platform SDK
- `packages/platform/internal`: thin internal tool adapter over the platform SDK
- `packages/kernel/runtime-deno-subprocess`: optional Deno subprocess runtime for TypeScript execution
- `packages/kernel/runtime-quickjs`: default QuickJS sandbox runtime for TypeScript execution
- `packages/kernel/runtime-ses`: optional SES sandbox runtime for TypeScript execution
- `packages/hosts/mcp`: MCP bridge for `execute` and `resume`
- `packages/kernel/core` plus `packages/sources/*`: core tool abstractions and first-party source integrations

## Releasing

- Add a changeset in any PR that should release: `bun run changeset`.
- Merge that PR to `main`. `.github/workflows/release.yml` opens or updates a `Version Packages` release PR for version bumps and changelog updates.
- Merge the `Version Packages` PR. The release workflow pushes the matching git tag and dispatches `.github/workflows/publish-executor-package.yml`, which publishes to npm and creates the GitHub release.
- Do not edit `apps/executor/package.json` by hand for normal releases. Changesets owns the version.
- For a beta train, enter prerelease mode with `bun run release:beta:start`, commit `.changeset/pre.json`, and merge it. Release PRs will then use `-beta.x` versions until you exit with `bun run release:beta:stop`.
- `bun run --cwd apps/executor release:publish` remains the publish implementation used by CI.
- To build and pack the publish artifact locally without publishing, run `bun run --cwd apps/executor release:publish:dry-run`.
- `.github/workflows/publish-executor-package.yml` can also be run manually with a tag input if a publish needs to be retried for an already-created version tag.
- One-time npm setup: either configure npm trusted publishing for `RhysSullivan/executor` with the workflow file `.github/workflows/publish-executor-package.yml`, or add a GitHub Actions secret named `NPM_TOKEN` that can publish the `executor` package.
- Stable releases use a normal semver like `1.2.3` and publish to npm under `latest`.
- Beta releases use a prerelease semver like `1.3.0-beta.1` and publish to npm under `beta`.
- When a release should become an upgrade test fixture, capture a real workspace snapshot with `bun run fixture:release:capture -- ...` and commit it under [`packages/platform/sdk/src/runtime/__fixtures__`](./packages/platform/sdk/src/runtime/__fixtures__/README.md).

## Project status

This repository is explicitly on its third major architecture iteration.

- `apps/` and `packages/` are the active implementation
- `legacy/` is the original codebase
- `legacy2/` is the second generation
