# Plugin Manifest Schema

Executor plugins need a manifest that can be validated before plugin code runs. The manifest is the stable contract between a plugin package, the Executor host, the installer, the capability grant system, and the local/cloud runtimes.

This document starts the manifest schema planning work. It proposes the responsibilities and rough shape of the manifest, but does not finalize the exact JSON schema, TypeScript types, package source format, or registry format.

## Goals

The manifest should make plugin identity explicit.

The manifest should describe immutable plugin versions and compatibility with Executor.

The manifest should declare the plugin's entrypoints and extension points without requiring the host to run plugin code first.

The manifest should declare requested capabilities so users, organizations, and hosts can review and grant them before execution.

The manifest should support both local and cloud execution using the same conceptual schema.

The manifest should support first-party and third-party plugins without creating a separate schema for each.

The manifest should give installers enough information to validate, store, audit, cache, and load plugin packages from npm, GitHub/git, local paths, or a future registry.

## Non-Goals

The manifest should not encode every runtime detail.

The manifest should not contain granted capabilities. It should declare requested capabilities. Grants are installation-specific state owned by the host.

The manifest should not contain secret values.

The manifest should not require one plugin type per package if multiple entrypoints are useful, but it should keep each entrypoint explicit.

The manifest should not replace plugin registration. Some details can still be registered by code at load time, but safety-relevant and install-relevant details should be visible before code execution.

## Responsibilities

The manifest has five main jobs.

### Identity

The manifest identifies the plugin and version.

Identity should be stable across local and cloud. It should be possible to answer which plugin version registered a source, tool, route, background service, UI surface, or storage namespace.

### Compatibility

The manifest declares which Executor versions and runtime APIs the plugin expects.

Compatibility should be checked before loading the plugin.

### Entrypoints

The manifest declares the code entrypoints the host may load.

Entrypoints should be explicit because different entrypoints may run in different contexts: source provider, secret store, route handler, background service, UI asset, or admin UI.

### Capabilities

The manifest declares requested capabilities.

Capability declarations are not grants. They are the plugin's requested access. The host decides which requested capabilities are granted for a specific installation, scope, user, organization, or environment.

### Package Sources

The manifest describes the package enough for validation and loading, but Executor should not require a custom distribution system at the start.

The default distribution path should be existing package distribution: npm packages, GitHub/git sources, and local paths for development. A future Executor registry can layer on top of the same manifest rather than replacing it.

## Proposed Top-Level Shape

The manifest should likely be a JSON-serializable object with these top-level sections:

```ts
type PluginManifest = {
  schemaVersion: string;
  id: string;
  name: string;
  version: string;
  description?: string;
  publisher?: PluginPublisher;
  license?: string;
  homepage?: string;
  repository?: string;
  categories?: PluginCategory[];
  compatibility: PluginCompatibility;
  entrypoints: PluginEntrypoints;
  capabilities?: PluginCapabilities;
  extensions?: PluginExtensions;
  storage?: PluginStorageDeclaration;
  package?: PluginPackageDeclaration;
  metadata?: Record<string, unknown>;
};
```

This is a planning type, not a final API.

## Identity Fields

### `schemaVersion`

The manifest schema version.

This lets Executor evolve the manifest format without guessing based on plugin version.

### `id`

The stable plugin ID.

The ID should be globally meaningful for published plugins and locally meaningful for path-based development plugins. It should not depend on install scope.

Plugin IDs should likely support npm-style package names because npm distribution is the default path. GitHub/git and future registry distribution should still resolve to the same stable plugin ID from the manifest.

### `name`

Human-readable plugin name.

### `version`

Immutable plugin version.

Published plugin artifacts should be immutable for a given `id` and `version`. If code changes, the version should change.

### `publisher`

Optional publisher identity.

This can support trust decisions, provenance, future signing, and future registry display.

## Package Sources

Executor should not reinvent plugin distribution before it needs to.

The install surface should support package sources rather than assuming one custom marketplace or registry. Initial sources should include npm packages, GitHub/git repositories, and local paths. A future Executor registry should be an additional package source, not a replacement for those.

User-facing install config can stay simple:

```ts
type PluginInstallSpec = string | [string, Record<string, unknown>];
```

The string identifies the package source. Examples might include `@executor/openapi`, `github:owner/repo`, `https://github.com/owner/repo.git`, or `./plugins/my-plugin`. Tuple options are installation configuration, not manifest data.

Resolved install metadata should be stored separately from the manifest. It should track the original spec, resolved source type, resolved version or commit, package root, manifest path, installed scope, timestamps, and load status.

```ts
type PluginPackageDeclaration = {
  source?: "npm" | "git" | "github" | "local" | "registry";
  packageName?: string;
  repository?: string;
};
```

This `package` block is optional planning shape, not final schema. For npm packages, standard `package.json` fields may already provide most of this information.

## Compatibility

Compatibility should be explicit and checked before plugin code is loaded.

```ts
type PluginCompatibility = {
  executor: string;
  runtimeApi?: string;
  platforms?: PluginPlatform[];
};

type PluginPlatform = "local" | "cloud";
```

`executor` should probably be a semver range for supported Executor versions.

`runtimeApi` can version the plugin bridge API separately from the product version if needed.

`platforms` lets a plugin declare whether it supports local, cloud, or both. The default should likely be both only if all declared entrypoints can run in both environments.

Open question: whether platform support belongs at the top level, per entrypoint, or both.

## Entrypoints

Entrypoints describe executable code or assets the host may load.

```ts
type PluginEntrypoints = {
  main?: PluginCodeEntrypoint;
  sdk?: PluginCodeEntrypoint;
  source?: PluginCodeEntrypoint;
  secretStore?: PluginCodeEntrypoint;
  apiGroup?: PluginCodeEntrypoint;
  apiHandlers?: PluginCodeEntrypoint;
  routeHandlers?: Record<string, PluginCodeEntrypoint>;
  backgroundServices?: Record<string, PluginCodeEntrypoint>;
  reactSource?: PluginUiEntrypoint;
  reactSecretProvider?: PluginUiEntrypoint;
  ui?: PluginUiEntrypoint;
  adminUi?: PluginUiEntrypoint;
};

type PluginCodeEntrypoint = {
  module: string;
  export?: string;
  runtime?: PluginRuntimeTarget;
};

type PluginRuntimeTarget = "worker" | "isolate" | "host-trusted";
```

The exact shape may change, but the manifest should avoid requiring the host to import a plugin just to discover what code exists.

Most third-party plugin code should target `worker` and `isolate` style execution, not `host-trusted` execution.

`host-trusted` may still be useful for internal plugins or development, but it should be explicit and not the default for third-party plugins.

Open question: whether source plugins should have a dedicated `source` entrypoint or register source behavior through `main`.

## SDK-Only Versus API And React Usage

Executor has two different consumption modes that the manifest needs to support.

An SDK-only consumer embeds Executor directly in an application. They need the SDK plugin factory and any required storage schemas, but they do not necessarily need HTTP routes, API handlers, React pages, or UI descriptors.

An API and React host needs more than the SDK plugin. It may need SDK registration, API route groups, API handlers, service bindings from the SDK executor extension, and React UI descriptors.

The manifest should make those layers explicit. Installing a plugin into the SDK should not automatically expose HTTP routes. Adding React UI should not imply the backend plugin exists. Exposing API routes should not imply a UI is available.

Current first-party plugins follow this layered shape:

- OpenAPI: SDK plugin, API group/handlers, React source UI.
- MCP: SDK plugin, API group/handlers, React source UI, with stdio support gated by host configuration.
- GraphQL: SDK plugin, API group/handlers, React source UI.
- WorkOS Vault: SDK secret provider plugin and optional React secret provider UI, with no required source UI.

The manifest should declare which SDK plugin ID each API or React entrypoint expects. That makes it possible for hosts to validate that a UI descriptor is not enabled without the matching SDK/API capability.

Example planning shape:

```ts
type PluginLayerDeclaration = {
  sdk?: {
    pluginId: string;
    entrypoint: keyof PluginEntrypoints;
  };
  api?: {
    requiresSdkPlugin: string;
    groupEntrypoint?: keyof PluginEntrypoints;
    handlersEntrypoint?: keyof PluginEntrypoints;
  };
  react?: Array<{
    kind: "source" | "secret-provider" | "settings" | "admin";
    requiresSdkPlugin?: string;
    requiresApi?: boolean;
    entrypoint: keyof PluginEntrypoints;
  }>;
};
```

This is planning shape, not final schema. The important requirement is that hosts can opt into layers independently while still validating that the selected layers are compatible.

Plugin options may also need to be layered. MCP is the current example: the SDK/API host can disable stdio MCP, while the React source UI must not expose stdio flows unless the server-side capability is enabled. The manifest and grant model should provide a way to represent these coupled options so UI does not promise behavior the SDK/API layer denies.

## Extensions

Extensions declare what the plugin contributes at a product level.

```ts
type PluginExtensions = {
  sources?: SourceExtensionDeclaration[];
  secretStores?: SecretStoreExtensionDeclaration[];
  tools?: ToolExtensionDeclaration[];
  routes?: RouteExtensionDeclaration[];
  uiSurfaces?: UiSurfaceDeclaration[];
  backgroundServices?: BackgroundServiceDeclaration[];
};
```

Some extension declarations may be fully static. Others may be partial declarations that are completed by plugin registration at load time.

The dividing line should be based on safety and install UX. Anything needed for capability review, routing, artifact loading, or policy decisions should be present in the manifest.

## Capabilities

Capabilities declare requested access. Grants are separate host state.

```ts
type PluginCapabilities = {
  tools?: ToolCapabilityDeclaration[];
  sources?: SourceCapabilityDeclaration[];
  secrets?: SecretCapabilityDeclaration[];
  network?: NetworkCapabilityDeclaration[];
  storage?: StorageCapabilityDeclaration[];
  scopes?: ScopeCapabilityDeclaration[];
  filesystem?: FilesystemCapabilityDeclaration[];
  execution?: ExecutionCapabilityDeclaration[];
  host?: HostCapabilityDeclaration[];
};
```

Capabilities should be deny-by-default. If a capability is missing, the runtime should deny that access.

### Tool And Source Capabilities

Tool and source capabilities should describe whether the plugin wants to discover tools, invoke tools, create tools, update tools, delete tools, or manage sources.

These capabilities need to compose with scopes. A plugin may request a kind of access, but the grant decides which scopes, sources, or tools it applies to.

### Secret Capabilities

Secret capabilities should distinguish between reading secret material and using a secret indirectly.

Most plugins should not need raw secret values. They should prefer host-mediated operations where possible.

### Network Capabilities

Network capabilities should declare allowed outbound hosts, protocols, and possibly ports.

The runtime should still enforce SSRF protections and redirect validation even when a host is allowed.

Open question: whether the manifest supports broad network capabilities like `network:any`, and whether those are first-party only, admin-only, or disallowed.

### Storage Capabilities

Storage capabilities should declare plugin storage namespaces or collections.

The runtime should namespace actual storage by plugin ID and installation scope regardless of what the plugin declares.

### Filesystem Capabilities

Filesystem capabilities are mainly relevant locally.

They should be denied by default and should describe requested mount points or abstract mounts rather than arbitrary host paths where possible.

Open question: whether third-party plugins should be allowed direct filesystem mounts at all, or whether filesystem access should be reserved for explicitly trusted/local plugins.

### Execution Capabilities

Execution capabilities describe whether the plugin can run code, define code-backed tools, spawn background work, or call execution APIs.

This is especially important for a custom-tools plugin because it is likely a first-party plugin that exposes controlled code execution to users or agents.

## Storage Declaration

The manifest should let plugins declare storage needs separately from storage grants.

```ts
type PluginStorageDeclaration = {
  collections?: Array<{
    name: string;
    kind: "kv" | "document" | "sql";
    description?: string;
  }>;
};
```

Storage declarations help the host pre-create, migrate, display, or approve plugin storage.

Open question: whether plugin storage migrations belong in the manifest, in code, or in a separate artifact.

## Artifacts And Caching

Plugins should be cacheable after they are resolved from their package source.

Executor does not need a custom publishing flow immediately. npm, GitHub/git, and local paths can be the initial distribution mechanisms. After a package is resolved, Executor can still cache the resolved package or build output as an internal artifact for repeatable local/cloud loading.

```ts
type PluginArtifacts = {
  files?: Array<{
    path: string;
    size?: number;
    sha256?: string;
    kind?: "code" | "asset" | "manifest" | "source-map";
  }>;
  bundle?: {
    format: "esm";
    main: string;
    size?: number;
    sha256?: string;
  };
};
```

Cloud and local do not need to store cached artifacts the same way, but they should agree on immutable identity and verification where possible.

For npm packages, immutable identity can come from package name and version plus package integrity metadata when available.

For GitHub/git sources, immutable identity should come from a resolved commit SHA rather than a branch name.

For local paths, immutable identity may be best-effort during development and should be treated differently from published packages.

Open question: whether cached artifact metadata lives inside the manifest, beside the manifest, or only in install metadata produced after resolution.

## Example Sketch

This example is intentionally incomplete and not final syntax.

```json
{
  "schemaVersion": "0.1",
  "id": "@executor/openapi",
  "name": "OpenAPI",
  "version": "0.1.0",
  "description": "Create Executor sources and tools from OpenAPI specs.",
  "compatibility": {
    "executor": ">=0.1.0",
    "runtimeApi": "0.1",
    "platforms": ["local", "cloud"]
  },
  "entrypoints": {
    "source": {
      "module": "./dist/source.js",
      "export": "default",
      "runtime": "worker"
    }
  },
  "extensions": {
    "sources": [
      {
        "kind": "openapi",
        "displayName": "OpenAPI"
      }
    ]
  },
  "capabilities": {
    "network": [
      {
        "hosts": ["*"]
      }
    ],
    "storage": [
      {
        "collection": "sources"
      }
    ]
  }
}
```

This example raises an immediate design issue: OpenAPI may need broad network access to call arbitrary APIs from imported specs. That capability is powerful and may need special grant UX, source-level grants, or host-mediated request policies rather than a simple wildcard.

## Open Questions

Should the manifest be embedded in `package.json`, stored as `executor.plugin.json`, or both?

Should plugin IDs be required to match npm package names when distributed through npm, or can one package expose a different manifest ID?

What exact source spec grammar should Executor support for npm, GitHub/git, registry, and local path plugins?

Should GitHub support mean git clone, GitHub tarball download, npm-style `github:owner/repo`, or all of them?

How should a future Executor registry compose with npm/GitHub distribution instead of replacing it?

Should a plugin package support multiple plugins, or should there be exactly one plugin per package?

Should extension declarations be fully static, or should code registration define most contributions after the manifest passes validation?

Should platform support be declared globally, per entrypoint, or per extension?

How should first-party-only or trusted-only capabilities be represented?

How should package integrity, checksums, provenance, and publisher verification work across npm, GitHub/git, local paths, and future registry packages?

How much artifact metadata belongs in the manifest versus registry metadata?

How should manifest-declared capabilities map to installation-specific grants and scope-specific policies?

How should manifest validation work for local development plugins that may not be fully bundled yet?

## Next Steps

The next planning pass should choose the manifest file location and exact top-level shape.

After that, the capability declaration and grant model should be designed because it will affect the manifest schema more than any other subsystem.

The source plugin contract should also be designed early because OpenAPI, GraphQL, and MCP are likely first-party source plugins and will validate whether the manifest can express real plugin needs.
