# Executor Plugin Architecture

Executor's plugin system is the main extension mechanism for the product. It should let Executor add new capabilities without putting every capability into the core SDK, and it should let users, teams, vendors, and the community extend Executor without waiting on first-party product work.

This document is an architecture planning document. It describes the intended shape of the plugin system and the boundaries it needs to preserve. It does not finalize exact APIs, manifest schemas, packaging formats, storage schemas, or sandbox internals.

## Goals

Plugins should be a core part of Executor, not an optional add-on.

The plugin system should support first-party plugins and third-party plugins with the same conceptual model. First-party plugins may be operationally more trusted, but they should not rely on privileged extension paths that third-party plugins can never use.

Plugins should work locally and in the cloud through the same product architecture. The runtime implementation can differ, but plugin authors and Executor product surfaces should not have to reason about separate local-only and cloud-only plugin systems.

Plugins should be capability-based. Loading a plugin should not imply access to all tools, all secrets, all scopes, the filesystem, the network, or host runtime APIs.

Plugins should compose with Executor's existing primitives: tools, sources, scopes, secrets, definitions, connections, and execution.

## Non-Goals

This document does not define the exact plugin manifest schema.

This document does not define the exact plugin authoring API.

This document does not choose final local sandbox internals.

This document does not choose final cloud worker packaging internals.

This document does not define every extension point Executor will ever support.

This document does not make workflow, generated UI, or custom tool product decisions beyond describing how plugins should be able to provide those capabilities.

## Core Model

Executor should separate plugin authoring from plugin execution.

Plugin authoring is the developer-facing model: a plugin package, manifest, registration API, lifecycle hooks, and declared capabilities.

Plugin execution is the runtime model: how plugin code is loaded, isolated, granted capabilities, called, limited, persisted, and cleaned up.

This separation matters because the ergonomic plugin API and the safe execution boundary are different problems. References like Pi and opencode are useful for plugin authoring and lifecycle. References like emdash, kody, and secure-exec are useful for untrusted execution.

## Plugin Types

Executor should support multiple plugin categories through one conceptual plugin system.

### Source Plugins

Source plugins add new ways to produce sources and tools. OpenAPI, GraphQL, and MCP should likely be first-party source plugins.

A source plugin may define how a source is configured, how tools are discovered, how tools are invoked, and how source-specific auth works.

### Secret Store Plugins

Secret store plugins add new ways to store, retrieve, or route secrets.

These plugins are sensitive because they sit near credential material. They need stronger capability and trust review than plugins that only contribute static metadata.

### Execution-Adjacent Plugins

Execution-adjacent plugins add capabilities built on top of code execution. A custom-tools plugin is the clearest example. It would let users or agents define code-backed tools that become part of the same source/tool model.

The important distinction is that custom tools are not a special core primitive. They are likely a first-party plugin built using core primitives.

### Product Capability Plugins

Product capability plugins add features that are useful across product surfaces but do not belong directly in the core SDK. Examples include execution logs, audit views, source discovery helpers, importers, admin UI, or workflow-related features.

## First-Party And Third-Party Plugins

First-party plugins are maintained by Executor. They should provide common capabilities without expanding the core SDK unnecessarily.

Likely first-party plugins include OpenAPI, GraphQL, MCP, custom tools, common secret storage adapters, execution logs, and source discovery helpers.

Third-party plugins are maintained by users, vendors, teams, or the community. They should be treated as untrusted by default.

The plugin system should avoid creating a privileged first-party-only path unless a feature genuinely requires one. If a first-party plugin needs capabilities that third-party plugins cannot safely receive, that difference should be explicit.

## Plugin Manifest

Plugins should have a manifest that is validated before execution.

At a high level, the manifest should describe identity, version, compatibility, entrypoints, plugin category, declared capabilities, extension points, and optional UI or asset bundles.

The manifest should support immutable plugin versions. Runtime caching, artifact storage, auditability, and rollback are all easier if a plugin version maps to stable code and stable declared metadata.

The manifest should also include compatibility metadata, such as supported Executor versions. This avoids loading plugins against incompatible host APIs.

The exact schema is a follow-up design topic.

## Registration And Lifecycle

Plugins should register extension points through a small typed API.

The authoring model should prefer explicit registration over ambient mutation. A plugin should declare what it contributes: source handlers, tool providers, secret store adapters, routes, UI surfaces, lifecycle hooks, or execution capabilities.

Plugin loading should be deterministic. Executor can resolve and prepare plugins in parallel, but activation should happen in a stable order so side effects, conflicts, and diagnostics are predictable.

Plugin lifecycle should include initialization and disposal. Runtime contexts should not be reusable after plugin reload, process restart, scope changes, or product session changes.

Executor should track plugin provenance for registered capabilities. When a tool, source, secret adapter, route, or UI surface exists because of a plugin, the product should know which plugin and version provided it.

## Conflict Policy

Executor should define conflict behavior early.

Source IDs, tool IDs, routes, UI surfaces, and secret store adapters can collide. The system should avoid silent ambiguous behavior.

Possible policies include first-wins, inner-scope-wins, explicit override, namespaced IDs, or install-time rejection. Different extension points may need different policies.

For source and tool visibility, Executor should preserve the existing scope model: reads resolve through an ordered scope stack, and writes target an explicit scope. Plugin-provided tools and sources should participate in that model rather than bypassing it.

## Capability Model

Plugins should not receive ambient authority.

A plugin should only be able to access the tools, sources, scopes, secrets, storage, network destinations, host APIs, and execution features it has been granted.

Capabilities should be declared by the plugin, reviewed or approved by the user or organization, and enforced by the runtime.

The capability model needs to distinguish between declaration and grant. A plugin can declare that it needs access to a secret, network host, storage namespace, or tool invocation API. The host decides whether to grant that access for a specific scope, user, organization, or installation.

Missing capability should mean hard denial. It should not fall back to best-effort behavior.

## Scopes And Plugins

Scopes define ownership and visibility for Executor resources. Plugins need to integrate with scopes rather than inventing a separate tenancy model.

Plugin installation should likely be scoped. A plugin may be installed for a user, workspace, organization, or another host-defined scope.

Plugin-created resources should write to explicit scopes. Plugin reads should resolve through the Executor scope stack only when the plugin has permission to read those scopes.

Plugin storage should be namespaced by plugin identity and scope. This prevents collisions between plugins and prevents a plugin from using generic storage as a side channel into another plugin's state.

## Runtime Boundary

Executor should assume third-party plugin code is untrusted.

The runtime boundary should be built around a narrow host-controlled bridge. Plugin code should not receive direct access to host process APIs, database clients, secret values, local filesystem access, platform bindings, Durable Objects, or unrestricted network fetch.

Instead, plugin code should call host-provided APIs. Those APIs enforce capabilities, validate payloads, cap sizes, redact sensitive data, and return structured results.

This bridge is part of the attack surface. It needs explicit method definitions, typed arguments, size limits, structured errors, request IDs, timeouts, and audit hooks.

## Cloud Runtime

Cloud plugin execution should use isolated worker execution.

Cloudflare Dynamic Worker Loaders are the expected primitive for running untrusted plugin code in the cloud. A plugin version should be loaded as an immutable worker bundle, and the host should call it through a narrow bridge.

Remote plugins should not receive ambient network access. Direct outbound network should be disabled where possible, and network access should route through a host-controlled fetch API that can enforce allowlists, SSRF protections, redirect validation, and credential stripping.

Cloud runtime state should not live inside the isolate. Isolates should be treated as cacheable but disposable. Durable state should live in host-managed storage such as D1, KV, R2, Durable Objects, or Executor's own storage adapters, always namespaced by plugin, version, tenant, and scope as appropriate.

Worker-loader stubs may need to be request-scoped when runtime bindings include request-specific, tenant-specific, or grant-specific data. The loaded code can be cached by immutable plugin version, but per-request authority should not be cached globally.

## Local Runtime

Local plugin execution should use an isolated JavaScript runtime rather than importing untrusted plugin code into the host process.

V8 isolates are the expected local primitive. Local plugins should run with no direct Node globals for filesystem, process, environment, network, child processes, or host module resolution.

Local filesystem access should be denied by default. If a plugin needs files, it should receive explicit mounted paths or virtual filesystem access. Host paths should be canonicalized, symlinks handled carefully, and native addons blocked unless there is a deliberate trusted path.

Local network access should be denied by default. If granted, it should be host, port, and protocol constrained, with private network, link-local, metadata, and loopback behavior handled deliberately.

Local execution needs budgets beyond simple timeout: heap, wall time, CPU time where possible, output size, bridge call count, bridge payload size, active handles, timers, and child process count if subprocesses are ever supported.

## Plugin Storage And Artifacts

Plugins need durable storage, but storage should be host-mediated.

Plugin storage should be namespaced by plugin ID, plugin version where relevant, installation scope, and tenant. The storage API should prevent plugins from reading or writing another plugin's data.

Plugin code and assets should be treated as artifacts. Published plugin versions should map to immutable artifacts with validated manifests, bundle metadata, checksums, and compatibility information.

Cloud storage can use a split model: object storage for bundle artifacts and database rows for searchable metadata, installation state, and indexes.

Local storage can use the same conceptual artifact model with local files or database rows. The important product behavior is that local and cloud agree on plugin identity, versioning, grants, and installed state.

## Distribution And Installation

Executor should support local development and package-based distribution.

Local development should support loading a plugin from a local path for iteration. Path-based plugins should require explicit IDs because there may be no package name to fall back to.

Package-based plugins should support stable IDs, versions, compatibility metadata, and validated entrypoints. Install-time package scripts should be disabled when fetching third-party packages.

The install flow should record provenance: where the plugin came from, which scope installed it, which version is installed, which capabilities were declared, and which capabilities were granted.

Executor should support a safe mode or pure mode that disables external plugins while still allowing core and internal functionality to start.

## Extension Points

Initial extension points should be conservative and tied to known product needs.

Likely extension points include source providers, tool providers, tool invocation handlers, secret stores, source importers, plugin routes, execution hooks, logs, UI surfaces, and background services.

Each extension point should define its trust boundary. Some extension points only contribute metadata. Others invoke code, access secrets, perform network calls, or affect authorization. They should not all share the same default capabilities.

Extension points should prefer explicit inputs and outputs over mutation of host objects. Where ordered mutation is needed, Executor should make ordering deterministic and visible.

## Background Services And Durable Work

Some plugins may need more than request/response execution.

Cloud plugins may need background services, scheduled jobs, retries, or realtime sessions. Durable Objects are a likely fit for long-lived coordination, per-plugin service state, websocket sessions, and serialized per-tenant execution.

This should be modeled explicitly rather than hidden inside plugin request handlers. A plugin manifest should eventually be able to distinguish between request handlers, background services, jobs, and UI assets.

Local equivalents may not use the same primitives, but should preserve the same conceptual lifecycle where possible.

## Security Principles

Plugin code should be untrusted by default.

All sensitive host access should go through capability-checked APIs.

Secrets should not be passed as ambient environment variables. Plugins should request secret-backed operations through host APIs, or receive scoped secret material only when explicitly granted.

Network access should be denied by default and mediated when granted.

Filesystem access should be denied by default and mediated when granted.

Plugin storage should be namespaced and scoped.

Payload sizes, output sizes, runtime duration, and bridge calls should be bounded.

Plugin errors should be isolated. A broken plugin should fail to load, fail its own operation, or be disabled without preventing Executor from starting when possible.

## Architecture Implications

Executor core should own the primitive contracts: tools, sources, scopes, secrets, plugin registration, capability grants, and execution bridge interfaces.

Executor core should not own every product capability. OpenAPI, GraphQL, MCP, custom tools, execution logs, workflow-related features, and generated UI support can be provided by plugins where practical.

The plugin system needs to be designed before many product features are finalized because it determines whether those features become core, first-party plugins, or third-party extension points.

Local and cloud implementations should share tests or conformance fixtures where possible. The exact runtime differs, but a plugin capability should mean the same thing in both environments.

## Reference Lessons

emdash demonstrates the cloud-side pattern Executor likely wants: Dynamic Worker Loader, no ambient network, bridge-mediated access, serialized request boundaries, and durable state outside the isolate.

kody demonstrates a broader Cloudflare operational model: separate ephemeral execution and app/service workers, Durable Objects for stateful coordination, deterministic bundle artifacts, and tenant-namespaced runtime state.

secure-exec demonstrates the local runtime shape: V8 isolates, deny-by-default permissions, virtual filesystem, mediated network, explicit module policy, and resource budgets beyond timeout.

Pi demonstrates an ergonomic plugin authoring model: small typed API, registration during load, lifecycle events, package discovery, and composable extension points. It does not provide the security model Executor needs.

opencode demonstrates practical plugin loading and distribution: simple config shape, provenance tracking, compatibility checks, deterministic activation, install-time script suppression, safe mode, and lifecycle cleanup. Its plugins are trusted, so Executor should borrow ergonomics but not the trust assumption.

## Follow-Up Architecture Work

The next research steps should turn this plan into narrower architecture documents.

Recommended follow-ups include plugin manifest and package format, plugin authoring API, capability declaration and grant model, cloud Dynamic Worker runtime, local V8 isolate runtime, plugin storage and artifact model, source plugin contract, secret store plugin contract, custom-tools plugin design, background service model, plugin UI model, and conformance testing across local and cloud.

Each follow-up should make concrete decisions in its own area while preserving the product model from `notes/research/product-model.md` and the plugin boundaries described here.
