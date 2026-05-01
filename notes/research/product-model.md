# Executor Product Model

Executor is a tool/source discovery and execution layer for agent-callable tools. It is designed around a small set of product primitives that can support multiple product surfaces: a public SDK, a local application, hosted cloud, and self-hosted cloud.

This document is intentionally high level. It is not an architecture decision record and does not attempt to design every subsystem in detail. Its purpose is to establish the product concepts, vocabulary, and composition model that later research and architecture documents can build on.

## Goals

Executor should make it easy for agents and applications to discover, configure, and call tools from many sources.

The product should not depend on Executor maintaining the largest possible fixed integration library. Happy paths like OpenAPI, GraphQL, and MCP should make common integrations easy, but users should always have a path to add custom tools when an existing integration is missing or incomplete.

The platform should be built from primitives that are stable enough to support the full product surface and extensible enough that new capabilities can be shipped as plugins instead of always requiring changes to the core.

The same core concepts should work locally and in the cloud. Local and remote execution may use different runtimes, but the plugin and execution model should feel like the same product architecture.

## Product Surfaces

Executor has four primary product surfaces.

### Core SDK

The SDK is the foundation that other applications can embed. It should expose the shared product primitives that make Executor useful: tools, sources, scopes, secrets, plugin support, and execution.

The SDK is not meant to contain every product feature. Features like hosted team management, execution history dashboards, workflow builders, and organization-level policy UI can be built above the SDK or delivered through plugins when they are not required for the primitive system to function.

The SDK should let product builders use Executor in their own applications. A common use case is an app with agents whose users need to connect their own sources, credentials, and tools. In that case, Executor should handle the hard parts of source configuration, tool discovery, credentials, refresh tokens, and tool invocation.

### Local Application

The local application is an open-source way to run Executor on a user's machine. It should provide the local equivalent of the cloud product's core capabilities: available tools and sources, an MCP gateway, configured sources, secrets, scopes, and plugin-based extensibility.

The local product matters because some users will want a tool gateway that runs near their files, development environment, local network, or personal credentials. It also provides a low-friction way to use Executor without committing to a hosted product.

### Hosted Cloud

Hosted cloud is the managed product for teams and companies. It should help organizations scale tool access across many users and agents.

Cloud adds product needs that are less important locally: organization management, bring-your-own auth, permissions, policy enforcement, auditability, shared secrets, hosted execution, and team-level governance.

### Self-Hosted Cloud

Self-hosted cloud should use the same product architecture as hosted cloud where possible. The goal is not to maintain a separate product, but to allow companies to run the cloud architecture themselves when they need stronger control over deployment, data, compliance, or network boundaries.

## Core Concepts

Executor is built around a small number of concepts.

### Tools

A tool is a callable unit of work. A tool has an ID, a name or function path, and may have input and output schemas.

Tool IDs are required. Input and output schemas are useful for agents, validation, generated interfaces, and documentation, but should not be treated as mandatory for every possible tool.

Tools are the lowest-level product object that agents ultimately call.

### Sources

A source is a collection of tools. For example, a Vercel source might contain tools for projects, deployments, DNS records, and environment variables.

Sources are how Executor groups related tools, credentials, configuration, and discovery behavior. A source may come from an imported spec, an MCP server, a first-party integration, a third-party plugin, or custom user code.

### Secrets

Secrets are credentials or sensitive values needed by tools and sources. Examples include bearer tokens, API keys, OAuth refresh tokens, and source-specific configuration values.

Secrets are a product primitive because tool execution often depends on them, and because controlling access to secrets is central to making plugins and untrusted code safe enough to use.

### Scopes

Scopes define ownership and visibility for sources, tools, definitions, secrets, and connections.

Hosts construct an ordered scope stack for an Executor instance. Reads can resolve through the stack, while writes target an explicit scope. This lets personal resources and credentials coexist with shared team or organization resources without requiring every product surface to hard-code the same ownership model.

The effective tool set an agent sees is the scope-resolved view of available sources and tools. Tools can come from happy-path imports, first-party plugins, third-party plugins, MCP servers, and plugin-provided custom tool support. A custom tool should become part of the same source/tool model rather than living in a separate one-off system.

### Plugins

Plugins are a core product concept, not an optional future feature. They are how Executor avoids putting every capability into the core SDK while still letting the platform grow.

Plugins can extend Executor with new spec types, source loaders, secret storage backends, execution-adjacent features, logging, product integrations, and other capabilities that do not belong directly in the core.

Plugins should be part of the shared local and cloud architecture. The details of packaging, loading, sandboxing, and runtime behavior should be researched separately, but the product model should assume plugins can work in both environments.

### Execution

Execution is the ability to run code that can call tools. This is a major Executor primitive because it unlocks higher-level experiences that can be built outside the core product or through plugins.

Execution should be designed with untrusted code in mind. Cloud execution is expected to use a cloud isolation primitive such as Cloudflare Dynamic Worker Loaders. Local execution is expected to use a local isolation primitive such as V8 isolates. The exact architecture is a dedicated follow-up topic.

## Plugin Strategy

Executor should be extensible by default. When a capability is important but not required for the core primitive system, it should be considered as a plugin candidate.

This does not mean everything must be a plugin. The core must still define the shared concepts, contracts, and minimal behavior needed for the product to work. Plugins should extend the system without fragmenting the product model.

### First-Party Plugins

First-party plugins are maintained by Executor. They provide common, supported capabilities without forcing those capabilities into the core SDK.

First-party plugin areas include OpenAPI, GraphQL, MCP, custom tools, common secret storage adapters, and other capabilities that are useful across product surfaces.

First-party plugins may be operationally trusted by Executor, but the product should still prefer the same conceptual plugin model used for third-party plugins. This keeps the architecture consistent and helps prevent first-party extensions from depending on privileged paths that third-party extensions can never use.

First party plugins should use the same plugin model as third-party plugins.

### Third-Party Plugins

Third-party plugins may come from users, vendors, teams, or the community. They should be treated as untrusted by default.

Installing or loading a plugin should not automatically grant access to all secrets, all tools, the local filesystem, or unrestricted network behavior. Plugins should receive explicit capabilities based on what the user, team, or policy grants.

Third-party plugins are strategically important because they let Executor cover specialized sources and product needs without waiting for the core team to ship everything.

## Capability-Based Access

Executor should lean toward capability-based access for plugins and untrusted execution.

A plugin-provided capability should only be able to access the secrets, tools, scoped storage, network capabilities, and runtime APIs it has been granted. The user or organization should be able to understand and control those grants.

This is important across local and cloud. Local plugins should not be allowed to read arbitrary local data just because they were installed. Cloud plugins should not be allowed to read organization-wide secrets or call organization-wide tools just because they exist in the same account.

The details of grant representation, policy enforcement, user experience, and runtime containment need deeper research. The product-level requirement is that untrusted plugins and code are possible without giving them ambient access to everything Executor knows.

## Local And Cloud Parity

Executor should aim for the same conceptual architecture locally and in the cloud.

The exact runtime may differ. Cloud may use Dynamic Worker Loaders, while local may use V8 isolates. The user-facing and developer-facing model should still be consistent: plugins declare or request capabilities, are granted scoped access, and interact with Executor through stable primitives.

Local and cloud parity matters because plugins should not need to be rewritten for each product surface. Some differences are inevitable, especially around deployment, persistence, identity, networking, and security boundaries, but the product should avoid creating separate local-only and cloud-only extension ecosystems.

## What Executor Enables

Executor is agnostic to the higher-level product built on top of its primitives.

Workflows, generated UI, custom tools, and agents running one-off scripts through MCP are important outcomes, but they should not be treated as product categories Executor core owns directly. They are examples of what becomes possible when tools, sources, scopes, secrets, plugins, and execution compose well.

### Custom Tools Plugin

Custom tools are likely provided by a first-party plugin rather than by Executor core directly. If a source does not have a happy-path integration, an agent or user should be able to write code that calls the target system and add that function to the available tool set through the same plugin and source/tool model.

This is a major difference from products that compete primarily on integration count. Executor should make missing integrations less fatal because a custom-tools plugin can use the same execution and source/tool primitives as other first-party or third-party plugins.

### Agent Scripts Over MCP

An agent connected through MCP should be able to use Executor as a gateway to call available tools. With execution, an agent can also run small scripts that combine tool calls.

Executor should enable this without requiring the core product to become a full scripting product. The important part is that the primitives support safe tool access and code execution.

### Generated UI

Generated UI can use Executor's source/tool discovery and invocation model to build interfaces around tools. A generated interface could call tools in a type-safe or RPC-like style using the available schemas and execution APIs.

Executor should not assume there is only one generated UI product. It should provide the primitives that make generated UI possible.

### Workflows

Workflows can be built as reusable compositions of tools that run on demand, on a schedule, or in response to events.

Executor should provide the tool, source, secret, scope, plugin, and execution primitives that workflows need, but this document does not define a workflow engine. Workflow design deserves its own research pass.

## Competitive Positioning

Executor overlaps with products like Zapier, Composio, Retool, and n8n, but it should not copy any one of them directly.

Zapier and n8n are strong workflow automation products. Retool is strong at internal applications and operational UI. Composio is closer to Executor's agent-tool integration surface.

Executor's wedge is that it is a programmable, extensible discovery and execution layer for agent-callable tools. The product should support happy-path integrations, but its main strategic advantage is that users are not blocked when a supported integration does not exist. Plugin-provided custom tools, plugins, and sources can become part of the same source/tool model.

The product should compete on primitives, extensibility, local/cloud parity, and agent-native tool access rather than only on the number of integrations advertised.

## Deeper Research Topics

The concepts in this document are part of the product model, but each needs a deeper follow-up research document before implementation decisions are finalized.

Important follow-up topics include plugin loading, plugin manifests, local sandboxing, cloud sandboxing, capability grants, secret storage, source importers, MCP gateway behavior, custom tool authoring, workflow composition, generated UI patterns, execution logs, auditability, persistence, policy, auth, and the public SDK shape.

Those follow-up documents should make architecture decisions where needed. This document should remain the shared product frame those decisions refer back to.
