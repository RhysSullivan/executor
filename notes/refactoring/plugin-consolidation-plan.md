# Plugin Consolidation & Refactoring Plan

## 1. Google Discovery -> OpenAPI Transformer

The `google-discovery` plugin has massive overlap with the `openapi` plugin. Both are REST-based, but `openapi` provides a much more robust HTTP invocation engine (handling parameter serialization, varied media types, etc.).

### Strategy
- **Deprecate the bespoke `google-discovery` plugin invocation and storage logic.**
- **Implement a Transformer:** Build a pre-processing utility that takes a Google Discovery JSON document and converts it into a standard OpenAPI v3.x specification.
- **Routing:** When a user adds a Google Discovery source, fetch the document, pass it through the transformer, and then feed the resulting OpenAPI spec directly into the `openapi` plugin's registration and execution flow.

### Considerations & "What gets lost"
- **Hierarchical Context:** Discovery groups tools by `Resource -> Sub-Resource -> Method`. OpenAPI is a flat list of paths. We must be careful with our tool naming strategy (e.g., retaining `drive.files.get` format) to prevent breaking existing prompts and user workflows.
- **Media Uploads:** Google has specialized `mediaUpload` objects (resumable, multipart) in Discovery. We need to map these to standard OpenAPI binary `POST` endpoints, ensuring we don't lose the ability to upload large files.
- **Global Parameters:** Discovery has service-wide parameters (`prettyPrint`, `fields`). We will likely need to inject these into every mapped OpenAPI operation to preserve functionality.
- **Method Descriptions:** Discovery descriptions are tied to the intent (`methodId`) rather than the location (`path`). We should map these directly to the OpenAPI `summary` or `description` fields.

## 2. Source Management Factory (MCP & GraphQL)

The `mcp` and `graphql` plugins cannot be absorbed into OpenAPI because their underlying protocols (JSON-RPC over stdio/HTTP, and GraphQL queries) are fundamentally different from REST. However, their database storage and API layers are nearly identical boilerplate.

### Strategy
- **Extract a `CoreSourceManager`:** Create a shared factory in the core SDK that provides the standard CRUD HTTP endpoints (`addSource`, `updateSource`, `getSource`, `removeSource`) and Drizzle database storage patterns for "Source + Bindings".
- **Thin Plugins:** Refactor the `mcp` and `graphql` plugins to use this factory. They should become thin wrappers that focus purely on:
  1. Translating their specific domain format into `ToolRegistration`s.
  2. Providing a bespoke `invoke` handler (the "Leaf Node" Execution pattern, similar to `cli-to-js`).

## 3. General Cleanup & Unification
- **Shared HTTP Client Logic:** Any remaining HTTP request building (like header resolution and secret injection) should be extracted into a shared SDK utility to prevent drift between REST-like plugins.
- **Plugin Definition Boilerplate:** Simplify `definePlugin` to require less boilerplate for standard source detection and usage tracking.