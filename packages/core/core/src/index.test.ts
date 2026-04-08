import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";

import {
  createExecutor,
  makeTestConfig,
  makeInMemorySourceRegistry,
  inMemoryToolsPlugin,
  tool,
  FormElicitation,
  UrlElicitation,
  ElicitationResponse,
  Source,
  type MemoryToolContext,
  type ToolId,
  type InvokeOptions,
  SecretId,
} from "./index";

const autoApprove: InvokeOptions = { onElicitation: "accept-all" };

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const GetItemInput = Schema.Struct({ itemId: Schema.Number });
const Item = Schema.Struct({ id: Schema.Number, name: Schema.String });
const EmptyInput = Schema.Struct({});
const LoginResult = Schema.Struct({ user: Schema.String, status: Schema.String });
const ConnectResult = Schema.Struct({ connected: Schema.Boolean, code: Schema.String });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SDK Executor", () => {
  it.effect("creates an executor with no plugins", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig());
      expect(executor.scope.name).toBe("test");
      expect(yield* executor.tools.list()).toHaveLength(0);
    }),
  );

  it.effect("runtime sources are listed separately from source managers", () =>
    Effect.gen(function* () {
      const sources = makeInMemorySourceRegistry();

      yield* sources.registerRuntime(new Source({
        id: "built-in",
        name: "Built In",
        kind: "built-in",
        runtime: true,
        canRemove: false,
        canRefresh: false,
      }));

      yield* sources.addManager({
        kind: "openapi",
        list: () =>
          Effect.succeed([
            new Source({
              id: "vercel",
              name: "Vercel API",
              kind: "openapi",
              runtime: false,
              canRemove: true,
              canRefresh: false,
            }),
          ]),
        remove: () => Effect.void,
      });

      expect((yield* sources.list()).map((source) => source.id)).toEqual([
        "built-in",
        "vercel",
      ]);
    }),
  );

  it.effect("memory plugin registers tools and they are discoverable", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            inMemoryToolsPlugin({
              namespace: "inventory",
              tools: [
                tool({
                  name: "listItems",
                  description: "List all items",
                  inputSchema: EmptyInput,
                  outputSchema: Schema.Array(Item),
                  handler: () => [
                    { id: 1, name: "Widget" },
                    { id: 2, name: "Gadget" },
                  ],
                }),
                tool({
                  name: "getItem",
                  description: "Get an item by ID",
                  inputSchema: GetItemInput,
                  outputSchema: Item,
                  handler: ({ itemId }: { itemId: number }) => ({ id: itemId, name: "Widget" }),
                }),
              ],
            }),
          ] as const,
        }),
      )

      const tools = yield* executor.tools.list();
      expect(tools).toHaveLength(2);
      expect(tools.map((t) => t.name)).toContain("listItems");
      expect(tools.map((t) => t.name)).toContain("getItem");
    }),
  );

  it.effect("invokes a tool with typed args", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            inMemoryToolsPlugin({
              namespace: "inventory",
              tools: [
                tool({
                  name: "getItem",
                  inputSchema: GetItemInput,
                  outputSchema: Item,
                  handler: ({ itemId }: { itemId: number }) => ({ id: itemId, name: "Widget" }),
                }),
              ],
            }),
          ] as const,
        }),
      );

      const result = yield* executor.tools.invoke("inventory.getItem", { itemId: 42 }, autoApprove);
      expect(result.data).toEqual({ id: 42, name: "Widget" });
      expect(result.error).toBeNull();
    }),
  );

  it.effect("validates input against schema", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            inMemoryToolsPlugin({
              namespace: "inventory",
              tools: [
                tool({
                  name: "getItem",
                  inputSchema: GetItemInput,
                  handler: ({ itemId }: { itemId: number }) => ({ id: itemId }),
                }),
              ],
            }),
          ] as const,
        }),
      );

      const exit = yield* executor.tools
        .invoke("inventory.getItem", { itemId: "not-a-number" }, autoApprove)
        .pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      const error = yield* Effect.flip(
        executor.tools.invoke("inventory.getItem", { itemId: "not-a-number" }, autoApprove),
      );
      expect(error._tag).toBe("ToolInvocationError");
    }),
  );

  it.effect("tool invocation fails for unknown tool", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig());
      const error = yield* Effect.flip(
        executor.tools.invoke("nonexistent", {}, autoApprove),
      );
      expect(error._tag).toBe("ToolNotFoundError");
    }),
  );

  it.effect("filters tools by query", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            inMemoryToolsPlugin({
              namespace: "store",
              tools: [
                tool({
                  name: "listItems",
                  description: "List all items",
                  inputSchema: EmptyInput,
                  handler: () => [],
                }),
                tool({
                  name: "createOrder",
                  description: "Create an order",
                  inputSchema: EmptyInput,
                  handler: () => ({}),
                }),
              ],
            }),
          ] as const,
        }),
      );

      const itemTools = yield* executor.tools.list({ query: "item" });
      expect(itemTools).toHaveLength(1);
      expect(itemTools[0]!.name).toBe("listItems");

      const orderTools = yield* executor.tools.list({ query: "order" });
      expect(orderTools).toHaveLength(1);
      expect(orderTools[0]!.name).toBe("createOrder");
    }),
  );

  it.effect("plugin extension is typed and accessible", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            inMemoryToolsPlugin({ namespace: "runtime", tools: [] }),
          ] as const,
        }),
      );

      expect(executor.inMemoryTools).toBeDefined();
      expect(typeof executor.inMemoryTools.addTools).toBe("function");

      yield* executor.inMemoryTools.addTools([
        tool({
          name: "dynamicTool",
          description: "Added at runtime",
          inputSchema: EmptyInput,
          handler: () => "dynamic result",
        }),
      ]);

      const tools = yield* executor.tools.list();
      expect(tools).toHaveLength(1);
      expect(tools[0]!.name).toBe("dynamicTool");

      const result = yield* executor.tools.invoke("runtime.dynamicTool", {}, autoApprove);
      expect(result.data).toBe("dynamic result");
    }),
  );

  it.effect("stores and lists secrets", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig());

      const secret = yield* executor.secrets.set({
        id: SecretId.make("api-key"),
        name: "API Key",
        value: "sk_test_123",
        purpose: "auth",
      });
      expect(secret.name).toBe("API Key");
      expect(secret.id).toBe("api-key");

      const listed = yield* executor.secrets.list();
      expect(listed).toHaveLength(1);
      expect(listed[0]!.name).toBe("API Key");

      // Can resolve by id
      const resolved = yield* executor.secrets.resolve(SecretId.make("api-key"));
      expect(resolved).toBe("sk_test_123");

      // Can check status
      const status = yield* executor.secrets.status(SecretId.make("api-key"));
      expect(status).toBe("resolved");
      const missing = yield* executor.secrets.status(SecretId.make("nonexistent"));
      expect(missing).toBe("missing");
    }),
  );

  it.effect("form elicitation: tool collects user input mid-invocation", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            inMemoryToolsPlugin({
              namespace: "auth",
              tools: [
                tool({
                  name: "login",
                  inputSchema: EmptyInput,
                  outputSchema: LoginResult,
                  handler: (_, ctx: MemoryToolContext) =>
                    Effect.gen(function* () {
                      const creds = yield* ctx.elicit(
                        new FormElicitation({
                          message: "Enter credentials",
                          requestedSchema: {
                            type: "object",
                            properties: {
                              username: { type: "string" },
                              password: { type: "string" },
                            },
                          },
                        }),
                      );
                      return {
                        user: creds.username as string,
                        status: "logged_in",
                      };
                    }),
                }),
              ],
            }),
          ] as const,
        }),
      );

      const result = yield* executor.tools.invoke("auth.login", {}, {
        onElicitation: () =>
          Effect.succeed(
            new ElicitationResponse({
              action: "accept",
              content: { username: "alice", password: "secret" },
            }),
          ),
      });

      expect(result.data).toEqual({ user: "alice", status: "logged_in" });
    }),
  );

  it.effect("elicitation declined returns error", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            inMemoryToolsPlugin({
              namespace: "auth",
              tools: [
                tool({
                  name: "login",
                  inputSchema: EmptyInput,
                  handler: (_, ctx: MemoryToolContext) =>
                    ctx.elicit(
                      new FormElicitation({
                        message: "Enter credentials",
                        requestedSchema: {},
                      }),
                    ),
                }),
              ],
            }),
          ] as const,
        }),
      );

      const error = yield* Effect.flip(
        executor.tools.invoke("auth.login", {}, {
          onElicitation: () =>
            Effect.succeed(new ElicitationResponse({ action: "decline" })),
        }),
      );

      expect(error._tag).toBe("ElicitationDeclinedError");
    }),
  );

  it.effect("elicitation with no handler auto-declines", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            inMemoryToolsPlugin({
              namespace: "auth",
              tools: [
                tool({
                  name: "login",
                  inputSchema: EmptyInput,
                  handler: (_, ctx: MemoryToolContext) =>
                    ctx.elicit(
                      new FormElicitation({
                        message: "Need input",
                        requestedSchema: {},
                      }),
                    ),
                }),
              ],
            }),
          ] as const,
        }),
      );

      const error = yield* Effect.flip(
        executor.tools.invoke("auth.login", {}, {
          onElicitation: undefined as never,
        }),
      );
      expect(error._tag).toBe("ElicitationDeclinedError");
    }),
  );

  it.effect("url elicitation: tool requests URL visit", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            inMemoryToolsPlugin({
              namespace: "oauth",
              tools: [
                tool({
                  name: "connect",
                  inputSchema: EmptyInput,
                  outputSchema: ConnectResult,
                  handler: (_, ctx: MemoryToolContext) =>
                    Effect.gen(function* () {
                      const result = yield* ctx.elicit(
                        new UrlElicitation({
                          message: "Please authorize the app",
                          url: "https://oauth.example.com/authorize?state=abc",
                          elicitationId: "oauth-abc",
                        }),
                      );
                      return { connected: true, code: result.code as string };
                    }),
                }),
              ],
            }),
          ] as const,
        }),
      );

      const result = yield* executor.tools.invoke("oauth.connect", {}, {
        onElicitation: (ctx) => {
          expect(ctx.request._tag).toBe("UrlElicitation");
          return Effect.succeed(
            new ElicitationResponse({
              action: "accept",
              content: { code: "auth-code-123" },
            }),
          );
        },
      });

      expect(result.data).toEqual({ connected: true, code: "auth-code-123" });
    }),
  );

  it.effect("plugin reads and writes secrets through the SDK", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            inMemoryToolsPlugin({
              namespace: "vault",
              tools: [
                tool({
                  name: "rotateKey",
                  inputSchema: Schema.Struct({
                    secretName: Schema.String,
                    newValue: Schema.String,
                  }),
                  outputSchema: Schema.Struct({
                    oldValue: Schema.String,
                    newValue: Schema.String,
                  }),
                  handler: (
                    { secretName, newValue },
                    ctx: MemoryToolContext,
                  ) =>
                    Effect.gen(function* () {
                      // Try to resolve the existing secret by key
                      const secretId = SecretId.make(secretName);
                      const status = yield* ctx.sdk.secrets.status(secretId);

                      let oldValue = "<none>";
                      if (status === "resolved") {
                        oldValue = yield* ctx.sdk.secrets.resolve(secretId);
                        yield* ctx.sdk.secrets.remove(secretId);
                      }

                      // Store the new value
                      yield* ctx.sdk.secrets.set({
                        id: secretId,
                        name: secretName,
                        value: newValue,
                        purpose: "api_key",
                      });

                      return { oldValue, newValue };
                    }),
                }),
              ],
            }),
          ] as const,
        }),
      );

      // 1. Write initial secret
      yield* executor.secrets.set({
        id: SecretId.make("DB_PASSWORD"),
        name: "DB_PASSWORD",
        value: "hunter2",
        purpose: "database",
      });

      // Verify it's there
      const before = yield* executor.secrets.list();
      expect(before).toHaveLength(1);
      expect(before[0]!.name).toBe("DB_PASSWORD");

      // 2 + 3. Invoke tool that reads the old secret and writes a new one
      const result = yield* executor.tools.invoke("vault.rotateKey", {
        secretName: "DB_PASSWORD",
        newValue: "correct-horse-battery-staple",
      }, autoApprove);

      // 4. Verify the tool returned old and new values
      expect(result.data).toEqual({
        oldValue: "hunter2",
        newValue: "correct-horse-battery-staple",
      });

      // 5. Read the updated secret store — should have the new value
      const after = yield* executor.secrets.list();
      expect(after).toHaveLength(1);
      expect(after[0]!.name).toBe("DB_PASSWORD");
    }),
  );

  // ---------------------------------------------------------------------------
  // Schema $ref deduplication
  // ---------------------------------------------------------------------------

  it.effect("schema returns compact TypeScript previews with shared definitions reused", () =>
    Effect.gen(function* () {
      const Address = Schema.Struct({
        street: Schema.String,
        city: Schema.String,
        zip: Schema.String,
      }).annotations({ identifier: "Address" });

      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            inMemoryToolsPlugin({
              namespace: "crm",
              tools: [
                tool({
                  name: "createContact",
                  description: "Create a contact",
                  inputSchema: Schema.Struct({
                    name: Schema.String,
                    homeAddress: Address,
                    workAddress: Address,
                  }),
                  handler: (args: unknown) => args,
                }),
                tool({
                  name: "createCompany",
                  description: "Create a company",
                  inputSchema: Schema.Struct({
                    companyName: Schema.String,
                    headquarters: Address,
                  }),
                  handler: (args: unknown) => args,
                }),
              ],
            }),
          ] as const,
        }),
      );

      const contactSchema = yield* executor.tools.schema("crm.createContact");
      const companySchema = yield* executor.tools.schema("crm.createCompany");

      expect(contactSchema.inputTypeScript).toBe(
        "{ name: string; homeAddress: Address; workAddress: Address }",
      );
      expect(companySchema.inputTypeScript).toBe(
        "{ companyName: string; headquarters: Address }",
      );
      expect(contactSchema.typeScriptDefinitions).toEqual({
        Address: "{ street: string; city: string; zip: string }",
      });
      expect(companySchema.typeScriptDefinitions).toEqual({
        Address: "{ street: string; city: string; zip: string }",
      });
    }),

  );

  it.effect("definitions are stored once across tools, not duplicated", () =>
    Effect.gen(function* () {
      const Address = Schema.Struct({
        street: Schema.String,
        city: Schema.String,
        zip: Schema.String,
      }).annotations({ identifier: "Address" });

      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            inMemoryToolsPlugin({
              namespace: "crm",
              tools: [
                tool({
                  name: "createContact",
                  inputSchema: Schema.Struct({
                    name: Schema.String,
                    homeAddress: Address,
                    workAddress: Address,
                  }),
                  handler: (args: unknown) => args,
                }),
                tool({
                  name: "createCompany",
                  inputSchema: Schema.Struct({
                    companyName: Schema.String,
                    headquarters: Address,
                  }),
                  handler: (args: unknown) => args,
                }),
              ],
            }),
          ] as const,
        }),
      );

      // The shared definitions store holds Address once —
      // not duplicated per tool
      const definitions = yield* executor.tools.definitions();
      expect(definitions["Address"]).toBeDefined();
      expect(Object.keys(definitions)).toHaveLength(1);
    }),
  );

  it.effect("close cleans up plugin resources", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            inMemoryToolsPlugin({
              namespace: "temp",
              tools: [
                tool({
                  name: "ephemeral",
                  inputSchema: EmptyInput,
                  handler: () => "here",
                }),
              ],
            }),
          ] as const,
        }),
      );

      expect(yield* executor.tools.list()).toHaveLength(1);
      yield* executor.close();
      expect(yield* executor.tools.list()).toHaveLength(0);
    }),
  );
});
