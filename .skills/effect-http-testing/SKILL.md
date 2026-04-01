---
name: effect-http-testing
description: Testing Effect HttpApi services end-to-end. Use when writing tests that involve Effect's HttpApi, HttpApiBuilder, HttpClient, HttpServer, or when testing any HTTP service/plugin built with @effect/platform. Covers proper layer composition, test server setup, HttpClient injection, and common pitfalls.
---

# Effect HTTP Testing

## Core Pattern

Define an API with `HttpApi`, implement handlers with `HttpApiBuilder.group`, serve it with `HttpApiBuilder.serve()`, and use `NodeHttpServer.layerTest` to get an in-process test server + `HttpClient` pointed at it.

```ts
import { expect, layer } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import {
  HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup,
  HttpClient, OpenApi
} from "@effect/platform"
import { NodeHttpServer } from "@effect/platform-node"

// 1. Define the API
class Item extends Schema.Class<Item>("Item")({
  id: Schema.Number,
  name: Schema.String,
}) {}

const ItemsGroup = HttpApiGroup.make("items")
  .add(HttpApiEndpoint.get("listItems", "/items").addSuccess(Schema.Array(Item)))
  .add(
    HttpApiEndpoint.get("getItem", "/items/:itemId")
      .setPath(Schema.Struct({ itemId: Schema.NumberFromString }))
      .addSuccess(Item)
  )

const MyApi = HttpApi.make("myApi").add(ItemsGroup)

// 2. Implement handlers
const ItemsLive = HttpApiBuilder.group(MyApi, "items", (handlers) =>
  handlers
    .handle("listItems", () => Effect.succeed([{ id: 1, name: "Widget" }]))
    .handle("getItem", (req) => Effect.succeed({ id: req.path.itemId, name: "Widget" }))
)

// 3. Build test layer
const ApiLive = HttpApiBuilder.api(MyApi).pipe(Layer.provide(ItemsLive))

const TestLayer = HttpApiBuilder.serve().pipe(
  Layer.provide(ApiLive),
  Layer.provideMerge(NodeHttpServer.layerTest),
)

// 4. Use layer() to share across tests
layer(TestLayer)("My API", (it) => {
  it.effect("works", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      // client is already pointed at the test server
      const response = yield* client.get("/items")
      // ...
    })
  )
})
```

## Critical Rules

### Layer composition order matters

`HttpApiBuilder.serve()` consumes `HttpApi.Api`. The API layer must be provided to it, not the other way around:

```ts
// CORRECT
HttpApiBuilder.serve().pipe(
  Layer.provide(ApiLive),
  Layer.provideMerge(NodeHttpServer.layerTest),
)

// WRONG — "Service not found: HttpApi.Api"
ApiLive.pipe(
  Layer.provide(HttpApiBuilder.serve()),
  Layer.provideMerge(NodeHttpServer.layerTest),
)
```

### layerTestClient prepends the server URL

`NodeHttpServer.layerTest` (and `HttpServer.layerTestClient`) produce an `HttpClient` that automatically prepends the test server's `http://127.0.0.1:<port>` to every request URL.

- Use **paths only** (`/items`, `/items/2`) in requests — not full URLs
- If your code builds full URLs (e.g. `http://localhost/items`), the client will produce `http://127.0.0.1:PORThttp://localhost/items` — an invalid URL
- When injecting the test client into code that normally uses a `baseUrl`, pass `baseUrl: ""` or skip the base URL entirely

### Path parameters need setPath()

Effect's `HttpApiEndpoint` with `:param` syntax does NOT automatically populate `req.path`. You must call `.setPath()` with a schema:

```ts
// WRONG — req.path is undefined
HttpApiEndpoint.get("getItem", "/items/:itemId").addSuccess(Item)

// CORRECT — req.path.itemId is typed and populated
HttpApiEndpoint.get("getItem", "/items/:itemId")
  .setPath(Schema.Struct({ itemId: Schema.NumberFromString }))
  .addSuccess(Item)
```

### OpenApi.fromApi generates the spec

Use `OpenApi.fromApi(api)` to generate an OpenAPI spec from an `HttpApi` definition. The generated spec:
- Uses `"Api"` as the default title (not the api id)
- Converts `:param` to `{param}` in paths
- Does NOT list path parameters in the `parameters` array — they're implicit in the path template
- Uses `group.endpoint` format for operationIds (e.g. `items.listItems`)

### Grab the test HttpClient from context

Inside `layer()` tests, the `HttpClient` is available in the Effect context:

```ts
layer(TestLayer)("tests", (it) => {
  it.effect("test", () =>
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient
      // Use it directly or wrap in a Layer for injection
      const clientLayer = Layer.succeed(HttpClient.HttpClient, httpClient)
    })
  )
})
```

### Use HttpClient for HTTP calls, not fetch

Production code should use `HttpClient` from `@effect/platform`, not raw `fetch`:

```ts
import { HttpClient, HttpClientRequest } from "@effect/platform"

// Build request
let request = HttpClientRequest.get("/items")
request = HttpClientRequest.setHeader(request, "accept", "application/json")
request = HttpClientRequest.setUrlParam(request, "limit", "10")

// Execute — requires HttpClient in context
const response = yield* client.execute(request)

// Read body
const data = yield* response.json  // Effect<unknown>
const text = yield* response.text  // Effect<string>
```

This makes testing clean — swap in a test client layer, no monkey-patching needed.

### Response headers are Record<string, string>

Effect's `HttpClientResponse.headers` is a plain `Record<string, string>`, not a Web `Headers` object. Don't call `.forEach()` or `.get()` on it:

```ts
// WRONG
response.headers.forEach((v, k) => ...)
response.headers.get("content-type")

// CORRECT
const ct = response.headers["content-type"]
const copy = { ...response.headers }
```

### HttpClientRequest.make takes uppercase methods

```ts
// The method parameter to make() must be uppercase
HttpClientRequest.make("GET")("/items")

// Or use the convenience methods
HttpClientRequest.get("/items")
HttpClientRequest.post("/items")
```

### Prepending base URLs to a client

Use `HttpClient.mapRequest` with `HttpClientRequest.prependUrl`:

```ts
const clientWithBase = Layer.effect(
  HttpClient.HttpClient,
  Effect.map(
    HttpClient.HttpClient,
    HttpClient.mapRequest(HttpClientRequest.prependUrl("https://api.example.com")),
  ),
).pipe(Layer.provide(baseClientLayer))
```

### Error assertions

Use `Effect.flip` to turn errors into values for assertion:

```ts
const error = yield* Effect.flip(someFailingEffect)
expect(error._tag).toBe("MyError")
```

### Dependencies

- `@effect/platform` — HttpApi, HttpClient, HttpServer, OpenApi
- `@effect/platform-node` — NodeHttpServer.layerTest (for Node/vitest)
- `@effect/vitest` — `layer()`, `it.effect()`, `expect`
