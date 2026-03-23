# Architecture

This document explains the active v3 architecture at a high level.

If `README.md` answers "what is this product and how do I use it?", this file answers "what are the major moving parts and how do they fit together?"

## One-line view

`executor` is a local daemonized control plane that turns connected sources into a workspace tool catalog and then runs TypeScript against that catalog, pausing for user interaction whenever a tool or auth flow needs it.

## System shape

```text
                +-----------------------+
                |   CLI / executor      |
                |  apps/executor        |
                +-----------+-----------+
                            |
                            | HTTP
                            v
+-------------+   +---------+---------+   +----------------+
| Browser UI  |-->| local server      |<--| MCP clients    |
| apps/web    |   | packages/platform |   | via /mcp       |
|             |   | /server           |   |                |
+-------------+   +---------+---------+   +----------------+
                            |
                            | provides runtime layer
                            v
                  +---------+---------+
                  | control plane      |
                  | packages/platform/ |
                  | control-plane      |
                  +----+-----+----+----+
                       |     |    |
         persistence --+     |    +-- source auth / discovery / inspection
                             |
                             +-- execution environment resolver
                             |
                             +-- live execution manager
                             v
                  +---------+---------+
                  | QuickJS sandboxed  |
                  | executor runtime   |
                  | packages/kernel/   |
                  | runtime-quickjs    |
                  | default executor   |
                  +--------------------+
```

## Design goals reflected in the code

The current architecture optimizes for a few specific ideas:

- local-first operation with one daemon instead of many disconnected tools
- one shared runtime for CLI, browser UI, and MCP access
- schema-rich tool usage instead of raw HTTP from prompts
- reusable source connections that become workspace-scoped tools
- human-in-the-loop execution that can pause and resume cleanly
- adapters for multiple source kinds without hardwiring product logic to one protocol

## Major components

### `apps/executor`: installed CLI and daemon manager

This is the main user entrypoint.

Responsibilities:

- exposes commands such as `up`, `down`, `status`, `doctor`, `call`, and `resume`
- ensures the local daemon is running before execution
- submits TypeScript executions to the local control plane
- handles paused interaction flows, including opening browser URLs when needed
- includes a few dev-only seed helpers for demo sources

Conceptually, the CLI is not the business logic. It is a thin user-facing shell over the local runtime.

### `packages/platform/server`: one local process for API, MCP, and UI

This package hosts the actual local server.

Responsibilities:

- creates the control-plane runtime
- mounts the control-plane HTTP API at `/v1`
- mounts the `executor` MCP endpoint at `/mcp`
- serves the web UI assets for normal browser routes
- writes PID metadata for daemon lifecycle management

This is an important architectural choice: the API and UI are served by the same local process, so the product behaves like one install rather than a pile of separate services.

### `packages/platform/sdk`: product core

This is the center of the system.

It contains the runtime layer, persistence integration, and the business logic for:

- local installation bootstrap
- accounts, organizations, and workspaces
- source discovery and connection
- source auth and credential flows
- source inspection and tool indexing
- secret and credential handling
- execution creation, resumption, and state tracking
- policy-aware tool invocation

If you want to understand the behavior of the product, this is the most important package.

### `packages/kernel/runtime-quickjs`: default code execution runtime

This package provides the TypeScript execution environment used by the local product.

At a high level it receives:

- an executor implementation
- a tool catalog
- a tool invoker

and runs user-authored code against that environment.

The default runtime executes code inside a QuickJS WebAssembly sandbox so tool calls stay proxied through the control plane.

The workspace can override that in `.executor/executor.jsonc` with `runtime: "quickjs" | "ses" | "deno"`.

### Runtime packages

The source-plugin reset intentionally removed the previous built-in source-adapter packages.

The remaining core packages are:

- `packages/kernel/core`: shared tool abstractions, discovery, schemas, and system tools
- `packages/hosts/mcp`: exposes the local runtime itself as an MCP server
- `packages/clients/react`: React hooks and client state wrappers for the local UI

Future source plugins can be added back on top of this runtime boundary.

## Runtime model

### Local installation bootstrap

On first startup, the control plane provisions a local installation automatically.

That bootstrap creates:

- one local account
- one personal organization
- one default workspace
- one local installation record that points at them

This means the product can work out of the box as a local single-user system without requiring an external identity or tenant setup step.

### Single daemon, shared state

All main entrypoints talk to the same local daemon:

- CLI commands call the local HTTP API
- the web app calls the same local HTTP API
- MCP hosts talk to the `/mcp` handler exposed by that same process

Because of that, these surfaces share:

- the same workspace
- the same connected sources
- the same secrets and credentials
- the same execution history and interaction state

## Persistence model

The persistence layer is local-file-backed.

Default behavior:

- workspace config and state are stored in local files

Optional behavior:

- future cloud backends can plug in behind Effect service boundaries

At a high level, the local control plane stores these domains:

- installation identity: local installation identity for the workspace
- source state: sources, auth sessions, source credential bindings
- tool model: tool artifacts and related metadata extracted from sources
- secret state: credentials and secret materials
- execution state: executions and execution interactions
- governance state: policies

This is why `executor` can reconnect sources once, inspect them later, and run multiple executions over time without rebuilding everything from scratch on every prompt.

## Source lifecycle

The source lifecycle is one of the defining architectural paths in the system.

### 1. Discovery

The Add Source flow starts with URL discovery.

The discovery service probes a URL and tries, in order, to determine whether it looks like:

- an OpenAPI source
- a GraphQL source
- an MCP source
- or an unknown endpoint

Discovery also produces metadata such as:

- inferred source kind
- confidence level
- probable auth style
- optional spec URL
- warnings
- potential namespace and transport hints

### 2. Connection and auth

Once a source is identified, the auth service drives the connection flow.

Depending on the source, that may involve:

- connecting immediately with no auth
- asking for a bearer token or other credential material
- creating an OAuth session and handing the user into a browser flow
- persisting auth bindings back to the source

The important architecture point is that source connection is not just a CRUD write. It is a runtime workflow that can branch into interactive auth.

### 3. Tool indexing

After a source is connected, `executor` materializes a workspace-visible tool model.

The exact extraction path depends on the source kind:

- OpenAPI sources are transformed from the OpenAPI document into tool manifests and typed operations
- GraphQL sources are introspected into callable query and mutation tools
- MCP sources are represented through persisted tool artifacts and runtime invocation metadata

This indexed representation is what powers search, inspection, and execution without re-parsing everything in the UI.

### 4. Inspection

The source inspection service reconstructs a rich inspection bundle for the UI.

That bundle includes:

- source metadata
- namespace and pipeline kind
- tool summaries
- tool detail payloads
- raw document text when available
- manifest and definitions JSON when available

The UI uses this to show both a tree view of tools and a search-oriented discovery view.

## Execution architecture

Execution is the other defining path in the system.

### 1. Create execution

An execution begins when the CLI, API, or MCP bridge submits TypeScript code.

The control plane creates an execution record with status such as:

- `pending`
- `running`
- `waiting_for_interaction`
- `completed`
- `failed`

### 2. Resolve the workspace execution environment

Before code runs, the runtime builds the execution environment for the current workspace.

That environment combines:

- built-in system tools from `codemode-core`
- `executor` internal tools such as `executor.sources.add`
- persisted tools generated from connected OpenAPI, GraphQL, and MCP sources

The resolver returns three things:

- the SES code executor
- the workspace tool catalog
- the tool invoker that actually dispatches calls

This resolver is the composition point where the whole product becomes one callable tool surface.

### 3. Run TypeScript

The code then runs inside the local SES sandbox runtime.

The intended calling pattern is:

1. discover a tool by intent
2. inspect its schema if needed
3. call the selected `tools.*` path

The runtime is deliberately opinionated here: the product is built around tool calls, not ad hoc `fetch` requests from user code.

### 4. Invoke tools through the control plane

When code calls a tool, the control plane decides how to handle it.

Possible paths include:

- built-in system tool invocation
- internal `executor` tool invocation
- OpenAPI tool invocation with resolved auth headers
- GraphQL tool invocation with resolved auth headers
- MCP tool invocation through the MCP connector

This is also the point where policy checks and source auth resolution happen.

### 5. Persist results and surface interactions

The execution service updates persistent execution state as the run progresses.

If a tool call or auth flow needs user interaction, the live execution manager:

- creates an execution interaction record
- marks the execution as `waiting_for_interaction`
- stores enough payload to resume later
- waits for a structured elicitation response

Once the response arrives, the manager moves the execution back to `running` and the code continues.

## Human interaction model

A major architectural feature of `executor` is that interactions are first-class runtime state.

This is handled by the live execution manager and the execution interaction tables.

That gives the product a clean pause/resume loop instead of forcing every host to improvise its own half-finished approval flow.

Interaction types include:

- URL-based flows, such as opening a secure credential page or OAuth URL
- form-like elicitation where a host can provide a structured response

This same idea is used both for direct CLI execution and for the MCP-facing `execute` and `resume` tools.

## API and MCP surfaces

### HTTP API

The control-plane HTTP API is mounted under `/v1`.

Major groups include:

- local installation and secret management
- OAuth
- organizations and memberships
- workspaces
- sources
- policies
- executions

The web UI is a client of this API.

### MCP bridge

`packages/hosts/mcp` exposes the local runtime as an MCP server.

The bridge registers two main tools:

- `execute`: run TypeScript against the local runtime
- `resume`: continue a paused execution

When the MCP host supports managed elicitation, the bridge can drive the interaction loop directly through MCP instead of requiring the caller to implement custom resume handling.

## Frontend architecture

The web app lives in `apps/web` and is a React app built with Vite.

At a high level:

- routes are managed with TanStack Router
- data access is wrapped by `@executor/react`
- the UI is focused on sources, source inspection, and secrets
- production assets are served by the local server
- development runs Vite separately while still embedding the same backend behavior

The frontend is intentionally thin. It is mostly a presentation layer over the control-plane API.

## Why the architecture is shaped this way

The system is trying to solve a specific product problem:

- give agents a better way to use tools than pasting giant manifests into prompts
- keep auth, credentials, and user interactions in a durable runtime
- let many protocols look like one workspace tool surface
- make CLI, UI, and MCP hosts all operate on the same local state

That is why the architecture keeps converging on the same central idea:

`executor` is not just a CLI and not just an MCP server. It is a local runtime that owns source connection, tool indexing, execution, and interaction state.

## Current boundaries

A few practical boundaries are worth calling out:

- the active implementation is local-first and single-daemon
- the current web app is React/Vite, not the older architectures mentioned in planning notes
- `legacy/` and `legacy2/` are historical context, not the active runtime
- policy infrastructure exists in the core, but the central product loop today is source connection plus execution

## Read next

- `README.md` for the product view and usage guidance
- `apps/executor/src/cli/main.ts` for the CLI surface
- `packages/platform/server/src/index.ts` for how the local server is assembled
- `packages/platform/sdk/src/runtime/` for the core runtime flows
