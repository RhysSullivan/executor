// ---------------------------------------------------------------------------
// @executor-js/plugin-example/server
//
// The server half of the example plugin. Demonstrates:
//   - extension methods that hold the canonical implementation
//   - an HttpApiGroup contributed via `routes`
//   - a late-binding `handlers` Layer that consumes the plugin's
//     extension via a Service tag (`ExampleExtensionService`); the host
//     binds the tag at boot for local or per request for cloud
//
// React and other browser-only deps live in `./client` — never here.
// ---------------------------------------------------------------------------

import {
  Context,
  definePlugin,
  Effect,
  HttpApi,
  HttpApiBuilder,
} from "@executor-js/sdk";

import { ExampleApi } from "./shared";

// Bundle the group into a single-group HttpApi for typing purposes only.
// The runtime composition uses group identity to merge into the host's
// FullApi, so this bundle never touches the host's wiring.
const ExampleApiBundle = HttpApi.make("example").add(ExampleApi);

interface ExampleExtension {
  readonly greet: (
    name: string,
  ) => Effect.Effect<{ readonly message: string; readonly count: number }>;
}

export class ExampleExtensionService extends Context.Service<
  ExampleExtensionService,
  ExampleExtension
>()("ExampleExtensionService") {}

const ExampleHandlers = HttpApiBuilder.group(ExampleApiBundle, "example", (h) =>
  h.handle("greet", ({ payload }) =>
    Effect.gen(function* () {
      const ext = yield* ExampleExtensionService;
      return yield* ext.greet(payload.name);
    }),
  ),
);

export const examplePlugin = definePlugin(() => ({
  id: "example" as const,
  packageName: "@executor-js/plugin-example",

  // No DB schema — the counter lives in plugin storage (in-memory) so
  // the example plugin doesn't pull in migration plumbing.
  storage: () => ({ count: 0 }),

  // Canonical implementation. CLI/tests/embedded callers and the HTTP
  // handler all hit this same code path.
  extension: (ctx): ExampleExtension => ({
    greet: (name: string) =>
      Effect.sync(() => {
        ctx.storage.count += 1;
        return {
          message: `hello ${name}`,
          count: ctx.storage.count,
        };
      }),
  }),

  routes: () => ExampleApi,
  handlers: () => ExampleHandlers,
  extensionService: ExampleExtensionService,
}));

export default examplePlugin;
