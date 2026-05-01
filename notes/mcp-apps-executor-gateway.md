# MCP Apps Through Executor Gateway

Executor can already act as a gateway to downstream MCP servers for tools. MCP
Apps support should preserve that same gateway property: add Executor once, and
UI-capable tools from downstream MCPs should keep working through the Executor
MCP server.

This note is about the Executor work, not the GitHub issue demo app.

## Goals

- Proxy downstream MCP Apps without degrading the direct MCP server experience.
- Make UI-capable tools discoverable through Executor's normal MCP surface.
- Support app template/resource loading through `resources/list`,
  `resources/templates/list`, and `resources/read`.
- Keep tool invocation and resource loading consistent across direct MCP,
  Executor gateway MCP, and future generated UI.
- Leave room for generated React UIs to embed existing MCP Apps as components.

## Terms

MCP Apps are not a separate top-level MCP object. In practice they are
UI-capable tools: a tool descriptor includes metadata pointing to a UI resource,
and the client reads that resource to render the app.

There are two compatibility tracks to care about:

- MCP Apps / ext-apps metadata: `_meta.ui.resourceUri`, often flattened as
  `_meta["ui/resourceUri"]`, with a `ui://...` resource whose MIME type is
  commonly `text/html;profile=mcp-app`.
- ChatGPT Apps SDK / Skybridge metadata: `_meta["openai/outputTemplate"]`,
  usually pointing to a `ui://widget/...` HTML resource with
  `text/html+skybridge`.

Executor should preserve both when present. It should not assume all hosts have
converged on one metadata key or MIME type yet.

## Resource Gateway

Executor needs a generic resource surface in addition to the current tool
surface.

Suggested executor-side APIs:

```ts
executor.resources.list({ source?: string, cursor?: string })
executor.resources.templates.list({ source?: string, cursor?: string })
executor.resources.read({ uri: string })
```

The MCP plugin should implement these by forwarding to downstream MCP
`resources/list`, `resources/templates/list`, and `resources/read`.

The host MCP server should expose the same through protocol handlers:

```txt
resources/list
resources/templates/list
resources/read
notifications/resources/list_changed
notifications/resources/updated
```

Resource reads must not go through tool calls. The app renderer expects a
resource read path that can fetch the template URI returned in tool metadata.

## URI Proxying

Executor can prefix downstream resource URIs and strip that prefix when it
forwards a request to the source MCP server.

Example:

```txt
downstream: ui://app/show_github_issue.html
executor:   executor+mcp://{sourceId}/ui/app/show_github_issue.html
```

or:

```txt
downstream: ui://app/show_github_issue.html
executor:   ui://executor/{sourceId}/app/show_github_issue.html
```

The first form is less likely to collide with app code that has assumptions
about the `ui://` authority/path shape. The second form may be friendlier to
hosts that only recognize `ui://`.

The important invariant is:

- every resource URI exposed by Executor must be globally unique inside the
  gateway MCP server
- Executor must maintain a reversible mapping back to `{ sourceId, uri }`
- tool metadata, tool results, resource listings, and resource contents should
  all use the same rewritten URI

## Response Body Rewriting

URI rewriting in metadata is not enough. HTML and JavaScript inside app
templates may contain baked-in references to their own `ui://...` resources or
may call host APIs with those URIs.

Executor probably needs a conservative response-rewrite layer for proxied app
resources:

- rewrite exact downstream resource URIs inside text resources
- rewrite known metadata keys in embedded JSON
- avoid broad string replacement that can corrupt unrelated content
- do not rewrite binary resources unless we add a format-specific rewriter

This is especially relevant for app HTML and JS. A downstream app might call
`window.openai.readResource("ui://...")`, use an MCP Apps host bridge resource
read method, or import a sibling resource by URI. If Executor has exposed the
app under a prefixed URI, those calls must use the prefixed form at the host
boundary and the stripped form at the downstream boundary.

## Iframe Shape

Gateway mode should not introduce a double app iframe.

The expected shape is:

```txt
ChatGPT / host
  iframe for downstream app template served through Executor
```

Executor should own the MCP transport/resource proxying, not wrap every
downstream app in an Executor app shell. A shell iframe is appropriate for
Executor's own generated UI feature, but direct downstream MCP Apps should render
as if the client connected to the downstream MCP server directly.

## Host Bridge Interception

The `client` or `window.openai` object used by the app belongs to the host/app
iframe runtime, not the agent model. Executor can influence it only through:

- the tool descriptor metadata it exposes
- the resource body it serves
- the resource URI mapping it applies
- any app shell it intentionally provides for Executor-owned generated UI

For proxied downstream apps, avoid injecting a custom client unless required for
compatibility. Injection creates a new compatibility surface and risks changing
how existing apps behave.

For Executor-owned generated UI, a shell can provide controlled APIs:

```ts
tools.github.issues.create(...)
tools.run(...)
UI.SomeDownstreamApp(...)
```

That is a separate feature from transparent gatewaying.

## Generated UI Integration

The open generative UI PR adds an Executor app shell that can render React
generated by the model and proxy tool calls back through Executor. That shell is
the right place to experiment with treating UI-capable tools as components.

Possible future convention:

```tsx
<UI.github.show_issue owner="facebook" repo="react" issue_number={28785} />
```

The generated UI shell would:

- resolve `UI.*` to a UI-capable tool
- call the tool or reuse supplied tool output
- load the tool's app template resource
- mount the downstream MCP App within a component boundary

This should be built on top of the same resource gateway. Generated UI should
not need a bespoke resource loader that bypasses Executor's MCP resource proxy.

## Compatibility Notes From Spike

- ChatGPT normalized a tool call to `show_github_issue`; an xmcp tool registered
  as `show-github-issue` failed with `Tool show_github_issue not found`.
  Gateway code should avoid changing tool names after discovery, and demo/tools
  intended for ChatGPT should prefer identifier-safe names.
- ChatGPT developer mode showed the widget template metadata separately from
  tool response metadata. Both descriptor metadata and tool-result metadata
  matter.
- Adding `_meta["openai/outputTemplate"]` alongside `_meta["ui/resourceUri"]`
  improved host compatibility.
- A host may say "Failed to fetch template" even when `tools/call` succeeds.
  Debug that as a resource-read/template metadata problem, not as a tool
  invocation problem.

## Open Questions

- Which URI prefix shape should Executor standardize on for proxied resources?
- Should Executor expose both original and rewritten URI in hidden metadata for
  debugging?
- Do we need resource body rewriting in v1, or can v1 document that apps must
  use host-provided current template state rather than hard-coded sibling URIs?
- How do we handle resource subscriptions through a gateway?
- Should `tool.search` include "has UI" / "template URI" hints so agents can
  intentionally choose UI-capable tools?
- Should generated UI expose MCP Apps as components directly, or only via a
  generic `<McpApp tool=... args=... />` primitive at first?

## References

- MCP resources specification:
  https://modelcontextprotocol.io/specification/draft/server/resources
- MCP schema reference for `resources/list` and `resources/read`:
  https://modelcontextprotocol.io/specification/2025-06-18/schema
- MCP Apps `RESOURCE_URI_META_KEY` docs:
  https://apps.extensions.modelcontextprotocol.io/api/variables/app.RESOURCE_URI_META_KEY.html
- xmcp resource docs:
  https://xmcp.dev/docs/core-concepts/resources
- xmcp MCP UI integration docs:
  https://xmcp.dev/docs/integrations/mcp-ui
- xmcp MCP Apps metadata docs:
  https://xmcp.dev/docs/core-concepts/tools#mcp-apps-metadata
- OpenAI Apps SDK / Skybridge compatibility docs:
  https://docs.skybridge.tech/fundamentals/apps-sdk
- Skybridge `registerWidget` API:
  https://docs.skybridge.tech/api-reference/register-widget
- Executor generative UI PR:
  https://github.com/RhysSullivan/executor/pull/263
