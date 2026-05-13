# Cloud Workspaces and Global Sources Plan

Date: 2026-05-04
Status: planning

## Summary

Cloud should introduce workspaces without making every organization create
one. The organization/global context remains a first-class working context for
org-wide sources, secrets, connections, and policies. Workspaces are optional
project contexts layered on top of that global context.

The product model is:

- `/:org` is the global organization context.
- `/:org/:workspace` is a workspace context.
- Global sources are available immediately in every workspace.
- Workspace sources can shadow global sources by namespace.
- Secrets, connections, and policies resolve through the active scope stack.
- Writes always name an explicit target scope. The server and SDK should not
  invent default write targets.

The user-facing explanation should avoid "scopes" where possible:

> Sources define capability. Secrets decide how that capability authenticates
> in the current context.

## Goals

- Make workspaces the project/context concept for cloud.
- Keep org/global useful without creating a fake default workspace.
- Preserve and extend the existing scope stack model.
- Make inherited global sources clear in the UI.
- Use URL context as the source of truth for org/workspace selection.
- Remove hidden request context headers.
- Keep v1 small: create workspaces, route by context, and preserve global
  source inheritance. No workspace permissions, deletion, granular usage
  tracking, or full personal override UI in the first pass.

## Non-goals for v1

- Workspace-specific membership or roles. Every org member can access every
  workspace.
- Workspace deletion.
- Workspace rename UI, though slugs/ids should allow it later.
- Org handle edit UI, though handles should allow it later.
- Per-workspace billing or usage tracking. Usage still rolls up to org.
- Full UI for every personal override path. The data model and API should leave
  a path to `user-workspace` and `user-org` overrides over time.
- Backward-compatible web/API routes, except `/mcp` compatibility.

## Product Model

### Organization/global context

The org/global context is not only an admin area. It is a working context.

At `/:org`, users see global org sources and org-level resources. Sources added
here are inherited by every workspace immediately. Existing org-scoped data
maps naturally to this context.

Org/global has the scope stack:

```txt
user-org -> org
```

### Workspace context

A workspace is a narrower project context inside an org. It layers over global.

At `/:org/:workspace`, users see workspace sources plus inherited global
sources. Sources added here are local to this workspace. If a workspace source
uses the same namespace as a global source, the workspace source shadows the
global one in that workspace.

Workspace has the scope stack:

```txt
user-workspace -> workspace -> user-org -> org
```

### Global sources

Global sources are worth keeping because source definitions and credentials are
separate concerns.

An org can define one global `stripe` source once. Each workspace and user can
then resolve credentials through the active scope stack:

- `user-workspace`: my credential for this workspace.
- `workspace`: shared credential for this workspace.
- `user-org`: my personal credential across this org.
- `org`: shared org/global credential.

This avoids duplicating source definitions while still letting secrets live at
the right level.

### Shadowing

Scope precedence decides effective behavior.

In a workspace, source/tool invocation uses the merged stack. If a workspace
source and global source have the same namespace/tool ids, the workspace source
wins.

The UI should still show the shadowed global source as disabled/muted with an
`Overridden` state so users understand why it is not effective in that
workspace.

## Routing

Web routes should be context-addressed:

```txt
/:org
/:org/sources/:namespace
/:org/connections
/:org/secrets
/:org/policies

/:org/:workspace
/:org/:workspace/sources/:namespace
/:org/:workspace/connections
/:org/:workspace/secrets
/:org/:workspace/policies
```

Use a reserved org-admin segment for pages that are not workspace contexts:

```txt
/:org/-/billing
/:org/-/settings
/:org/-/workspaces
```

This keeps `/:org/:workspace` clean and avoids a large reserved-word list for
workspace slugs.

`/` should redirect to the signed-in user's current or first org global
context, not force a workspace.

Breaking old web routes is acceptable. Prefer less compatibility code.

## API Context

The API should also be context-addressed.

```txt
/api/:org/...
/api/:org/:workspace/...
```

The URL context determines which executor scope stack the server builds. Reads
operate against that stack. Writes still pass an explicit target scope id in
the payload/path; the URL context only bounds what targets are legal.

Remove the current hidden context header pattern. Session identity proves the
user; URL org/workspace resolves and authorizes the context.

The session should no longer be treated as the source of truth for "active org"
when routing protected app/API requests. The URL org handle is the context.
Every request authorizes that the signed-in user is an active member of that
org. Workspace requests also verify that the workspace belongs to the org.

## MCP

MCP should get explicit context URLs too:

```txt
/:org/mcp
/:org/:workspace/mcp
```

Keep `/mcp` as a compatibility fallback. It should resolve to the signed-in
user's org/global context. Do not use "last active workspace" as hidden state.

OAuth and MCP-related flows should preserve the context path so callbacks land
back in the same org/workspace context.

## UI Plan

Use the same shell and left nav shape for global and workspace contexts. The
context switcher shows `Global` alongside workspaces:

```txt
Acme / Global
Acme / Billing API
```

The switcher should show `Global` pinned at the top, then a separator, then
workspaces. Workspaces can be created from the switcher in v1.

Left nav stays stable across contexts. Workspaces should not appear in the
left nav; they live in the context switcher.

When in global context, billing/admin links are available. In workspace
context, the main working nav remains focused on sources, connections, secrets,
and policies.

### Sources sidebar

In global context, the sources sidebar shows global sources.

In workspace context, split the sources list into:

- Workspace sources.
- Global sources.

Inherited global sources are visible in workspace context. If a workspace
source shadows a global source, show the global source as muted/disabled with
an `Overridden` state.

### Source detail

Inherited global source detail can open inside the workspace URL so users can
inspect effective credentials and connect workspace-specific credentials
without losing context.

Editing the inherited source definition should only happen from global context.
Workspace detail pages should link to `/:org/sources/:namespace` for editing
the global source definition.

### Source creation

Source definition writes should target only:

- `org` / Global.
- current `workspace`.

Personal source definitions are not part of v1. Personal scopes are for
credentials, connections, policies, and future overrides.

Add-source forms should show a visible target selector and pass the selected
target explicitly.

### Secrets and connections

Secrets/connections should initially show the effective credential state by
default. A fuller grouped view can come later.

The full credential storage stack is:

- Only me in this workspace: `user-workspace`.
- Everyone in this workspace: `workspace`.
- Only me across this org: `user-org`.
- Everyone in this org: `org`.

The client may choose a visible default, but every write must pass the chosen
target scope explicitly.

### Policies

Policies should have a path to the full stack:

- `user-workspace`
- `workspace`
- `user-org`
- `org`

The API/storage model should support this. The v1 UI can expose a narrower
surface if needed, but should not paint the product into an org/workspace-only
corner.

## IDs, Handles, and Slugs

Use stable ids internally and mutable URL handles/slugs externally.

- Org URL segment is a local unique handle.
- Workspace URL segment is a slug unique within the org.
- Handles/slugs are generated automatically from names in v1.
- Collision handling appends a suffix.
- Do not use handle/slug as a primary key or scope id.
- Org handles and workspace slugs should be editable later, with redirects
  added later if needed.

Use prefixed random ids for new local entities, following the Unkey-style ID
helper pattern:

```txt
workspace_<base58 random>
```

WorkOS user/org ids can stay as identity anchors. Do not invent local org/user
primary ids unless the product needs to move off WorkOS ids.

Scope ids should be deterministic and prefixed:

```txt
org_<orgId>
workspace_<workspaceId>
user_org_<userId>_<orgId>
user_workspace_<userId>_<workspaceId>
```

Existing raw org scope ids should be handled in the one-shot migration so new
code has one org-scope convention.

## Data Model

Add local organization handle support:

```txt
organizations.handle text not null unique
```

Add workspaces:

```txt
workspaces
  id text primary key
  organization_id text not null references organizations(id)
  slug text not null
  name text not null
  created_at timestamptz not null default now()
  updated_at timestamptz not null default now()

unique (organization_id, slug)
```

Workspace names do not need to be unique. Slugs are unique within an org.

No workspace membership table in v1. Org membership grants access to all
workspaces.

No default workspace. Existing org/global resources stay org/global.

## Migration

A one-shot migration is acceptable because cloud has few users.

Migration should:

- Add org handles and backfill from org names with collision suffixes.
- Add workspaces table.
- Move existing raw org scope ids to prefixed `org_<orgId>` scope ids across
  scoped tables, unless we decide to preserve raw ids as a legacy read path.
- Preserve existing org-level sources as global sources.
- Preserve existing user-org personal data under the new
  `user_org_<userId>_<orgId>` convention if those rows exist.

Prefer migration over long-term legacy compatibility.

## Executor Construction

Cloud should construct executors from URL-resolved context:

Global:

```txt
[
  Scope(user_org_<userId>_<orgId>, "Me / <org>"),
  Scope(org_<orgId>, "<org> Global")
]
```

Workspace:

```txt
[
  Scope(user_workspace_<userId>_<workspaceId>, "Me / <workspace>"),
  Scope(workspace_<workspaceId>, "<workspace>"),
  Scope(user_org_<userId>_<orgId>, "Me / <org>"),
  Scope(org_<orgId>, "<org> Global")
]
```

The scope API should return both:

- The active display/write context, usually global or workspace.
- The full stack for UI storage-target selectors and inherited resource
  display.

Do not rely on `executor.scopes.at(-1)` as "the current write scope" once
workspace context exists. The active source-definition scope is `org` in global
context and `workspace` in workspace context.

## Explicit Write Target Invariant

All scoped writes must pass a target scope explicitly.

The client may select a visible default, but the server and SDK should not
guess. This applies to:

- Source definitions.
- Secrets.
- Connections.
- Policies.
- OAuth token writes.
- Plugin-owned scoped side tables.

The context URL bounds legal targets. A workspace-context request can target
any scope in its stack. A global-context request can target `user-org` or
`org`.

## Implementation Slices

### 1. Domain and ids

- Add ID helper for local prefixed ids.
- Add org handle generation.
- Add workspace schema and migration.
- Add deterministic scope id helpers.
- Add URL handle/slug resolvers.

### 2. Context-addressed web/API routing

- Move app routes under `/:org` and `/:org/:workspace`.
- Move protected API under `/api/:org` and `/api/:org/:workspace`.
- Remove hidden context headers.
- Resolve org/workspace from URL in protected middleware.
- Build global or workspace executor scope stack from resolved context.

### 3. Scope API and client context

- Update scope info to expose active context plus full stack.
- Update `ScopeProvider` consumers to use active source-definition scope for
  source reads/writes.
- Keep full stack available for credential/policy target selectors.

### 4. Sources UI

- Update context switcher with `Global` plus workspaces.
- Add create-workspace flow in switcher.
- Split workspace source sidebar into workspace and global sections.
- Show shadowed global sources as overridden.
- Add visible source target selector for add-source flows.
- Route global-source definition edits through global context.

### 5. Secrets, connections, policies

- Make write target selection visible and explicit.
- Start with effective credential display where simplest.
- Preserve API/storage path to full-stack personal overrides.

### 6. MCP and OAuth context

- Add `/:org/mcp` and `/:org/:workspace/mcp`.
- Keep `/mcp` fallback to signed-in org/global.
- Preserve context path in OAuth session/callback payloads.

## Open Details

- Exact generated slug collision format.
- Exact labels for credential target selector.
- Whether the first implementation exposes all policy target scopes in UI or
  only wires API/storage support.
