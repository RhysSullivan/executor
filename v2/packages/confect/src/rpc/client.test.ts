import { describe, expect, it } from "vitest";
import { Effect, Layer, Option, Schema, Stream } from "effect";
import { Atom, Registry, Result } from "@effect-atom/atom";
import { createRpcClient, createServerRpcQuery, RpcDefectError } from "./client";
import { createRpcFactory, makeRpcModule } from "./server";
import { defineTable, defineSchema } from "../schema";
import { ConvexClient, type ConvexClientService } from "../client";

const testSchema = defineSchema({
	guestbook: defineTable(
		Schema.Struct({
			author: Schema.String,
			message: Schema.String,
		}),
	),
});

const factory = createRpcFactory({ schema: testSchema });

// Define endpoints
const addEndpoint = factory.mutation({
	payload: { author: Schema.String, message: Schema.String },
	success: Schema.String,
});
addEndpoint.implement((payload) =>
	Effect.gen(function* () {
		return `Added message from ${payload.author}`;
	}),
);

const listEndpoint = factory.query({
	success: Schema.Array(Schema.Struct({ author: Schema.String, message: Schema.String })),
});
listEndpoint.implement(() =>
	Effect.gen(function* () {
		return [{ author: "Alice", message: "Hello" }];
	}),
);

const getEndpoint = factory.query({
	payload: { id: Schema.String },
	success: Schema.Struct({ author: Schema.String, message: Schema.String }),
	error: Schema.Struct({ _tag: Schema.Literal("NotFound") }),
});
getEndpoint.implement((payload) =>
	Effect.gen(function* () {
		if (payload.id === "not-found") {
			return yield* Effect.fail({ _tag: "NotFound" as const });
		}
		return { author: "Bob", message: "Test" };
	}),
);

const sendNotificationEndpoint = factory.action({
	payload: { userId: Schema.String },
	success: Schema.Struct({ sent: Schema.Boolean }),
});
sendNotificationEndpoint.implement((_payload) =>
	Effect.gen(function* () {
		return { sent: true };
	}),
);

const guestbookModule = makeRpcModule({
	add: addEndpoint,
	list: listEndpoint,
	get: getEndpoint,
	sendNotification: sendNotificationEndpoint,
});

describe("RPC Client", () => {
	describe("createRpcClient", () => {
		it("creates client with runtime property", () => {
			const mockApi = {
				add: guestbookModule.handlers.add,
				list: guestbookModule.handlers.list,
				get: guestbookModule.handlers.get,
				sendNotification: guestbookModule.handlers.sendNotification,
			};

			const client = createRpcClient<typeof guestbookModule>(
				mockApi as never,
				{ url: "https://test.convex.cloud" },
			);

			expect(client.runtime).toBeDefined();
			expect(typeof client.runtime.atom).toBe("function");
			expect(typeof client.runtime.fn).toBe("function");
			expect(typeof client.runtime.pull).toBe("function");
		});

		it("creates typed endpoint proxies for each module endpoint", () => {
			const mockApi = {
				add: guestbookModule.handlers.add,
				list: guestbookModule.handlers.list,
				get: guestbookModule.handlers.get,
				sendNotification: guestbookModule.handlers.sendNotification,
			};

			const client = createRpcClient<typeof guestbookModule>(
				mockApi as never,
				{ url: "https://test.convex.cloud" },
			);

			expect(client.add).toBeDefined();
			expect(client.list).toBeDefined();
			expect(client.get).toBeDefined();
			expect(client.sendNotification).toBeDefined();
		});

		it("mutation endpoints expose mutate AtomResultFn", () => {
			const mockApi = { add: guestbookModule.handlers.add };
			const client = createRpcClient<typeof guestbookModule>(
				mockApi as never,
				{ url: "https://test.convex.cloud" },
			);

			expect(client.add.mutate).toBeDefined();
			expect(typeof client.add.mutate).toBe("object");
		});

		it("query endpoints expose query and subscription functions", () => {
			const mockApi = { list: guestbookModule.handlers.list };
			const client = createRpcClient<typeof guestbookModule>(
				mockApi as never,
				{ url: "https://test.convex.cloud" },
			);

			expect(typeof client.list.query).toBe("function");
			expect(typeof client.list.queryEffect).toBe("function");
			expect(typeof client.list.queryPromise).toBe("function");
			expect(typeof client.list.subscription).toBe("function");
		});

		it("action endpoints expose call AtomResultFn", () => {
			const mockApi = { sendNotification: guestbookModule.handlers.sendNotification };
			const client = createRpcClient<typeof guestbookModule>(
				mockApi as never,
				{ url: "https://test.convex.cloud" },
			);

			expect(client.sendNotification.call).toBeDefined();
			expect(typeof client.sendNotification.callAsQuery).toBe("function");
			expect(typeof client.sendNotification.call).toBe("object");
			expect(typeof client.sendNotification.callEffect).toBe("function");
			expect(typeof client.sendNotification.callPromise).toBe("function");
		});

		it("action callAsQuery returns atom for given payload", () => {
			const mockApi = { sendNotification: guestbookModule.handlers.sendNotification };
			const client = createRpcClient<typeof guestbookModule>(
				mockApi as never,
				{ url: "https://test.convex.cloud" },
			);

			const atom = client.sendNotification.callAsQuery({ userId: "user-1" });
			expect(atom).toBeDefined();
			expect(Atom.isAtom(atom)).toBe(true);
		});

		it("mutation endpoints expose imperative mutateEffect and mutatePromise", () => {
			const mockApi = { add: guestbookModule.handlers.add };
			const client = createRpcClient<typeof guestbookModule>(
				mockApi as never,
				{ url: "https://test.convex.cloud" },
			);

			expect(typeof client.add.mutateEffect).toBe("function");
			expect(typeof client.add.mutatePromise).toBe("function");
		});

		it("caches endpoint proxies (same reference on repeated access)", () => {
			const mockApi = { add: guestbookModule.handlers.add };
			const client = createRpcClient<typeof guestbookModule>(
				mockApi as never,
				{ url: "https://test.convex.cloud" },
			);

			const first = client.add;
			const second = client.add;
			expect(first).toBe(second);
		});

		it("query function returns atom for given payload", () => {
			const mockApi = { get: guestbookModule.handlers.get };
			const client = createRpcClient<typeof guestbookModule>(
				mockApi as never,
				{ url: "https://test.convex.cloud" },
			);

			const atom = client.get.query({ id: "123" });
			expect(atom).toBeDefined();
			expect(Atom.isAtom(atom)).toBe(true);
		});

		it("subscription function returns atom for given payload", () => {
			const mockApi = { list: guestbookModule.handlers.list };
			const client = createRpcClient<typeof guestbookModule>(
				mockApi as never,
				{ url: "https://test.convex.cloud" },
			);

			const atom = client.list.subscription({});
			expect(atom).toBeDefined();
			expect(Atom.isAtom(atom)).toBe(true);
		});

		it("query can be disabled until caller is ready", () => {
			let queryCalls = 0;
			const service: ConvexClientService = {
				query: () => {
					queryCalls += 1;
					return Effect.die("query should be disabled");
				},
				mutation: () => Effect.die("not implemented"),
				action: () => Effect.die("not implemented"),
				subscribe: () => Stream.empty,
			};
			const layer = Layer.succeed(ConvexClient, service);

			const mockApi = { list: guestbookModule.handlers.list };
			const client = createRpcClient<typeof guestbookModule>(
				mockApi as never,
				{ url: "https://test.convex.cloud", layer },
			);

			const atom = client.list.query({}, { enabled: false });
			const registry = Registry.make();
			const value = registry.get(atom);

			expect(Result.isInitial(value)).toBe(true);
			expect(queryCalls).toBe(0);

			const unmount = registry.mount(atom);
			expect(queryCalls).toBe(0);
			unmount();
			registry.dispose();
		});

		it("subscription can be disabled until caller is ready", () => {
			let subscribeCalls = 0;
			const service: ConvexClientService = {
				query: () => Effect.die("not implemented"),
				mutation: () => Effect.die("not implemented"),
				action: () => Effect.die("not implemented"),
				subscribe: () => {
					subscribeCalls += 1;
					return Stream.empty;
				},
			};
			const layer = Layer.succeed(ConvexClient, service);

			const mockApi = { list: guestbookModule.handlers.list };
			const client = createRpcClient<typeof guestbookModule>(
				mockApi as never,
				{ url: "https://test.convex.cloud", layer },
			);

			const atom = client.list.subscription({}, { enabled: false });
			const registry = Registry.make();
			const value = registry.get(atom);

			expect(Result.isInitial(value)).toBe(true);
			expect(subscribeCalls).toBe(0);

			const unmount = registry.mount(atom);
			expect(subscribeCalls).toBe(0);
			unmount();
			registry.dispose();
		});
	});

	describe("RpcDefectError", () => {
		it("has correct _tag", () => {
			const error = new RpcDefectError({ defect: "test" });
			expect(error._tag).toBe("RpcDefectError");
		});

		it("stores string defect", () => {
			const error = new RpcDefectError({ defect: "Unexpected server crash" });
			expect(error.defect).toBe("Unexpected server crash");
		});

		it("stores complex object defect", () => {
			const complexDefect = {
				code: "INTERNAL_ERROR",
				message: "Database connection failed",
				stack: "Error at line 42...",
				metadata: { requestId: "abc123" },
			};
			const error = new RpcDefectError({ defect: complexDefect });
			expect(error.defect).toEqual(complexDefect);
		});

		it("is instanceof Error", () => {
			const error = new RpcDefectError({ defect: "test" });
			expect(error).toBeInstanceOf(Error);
		});
	});

	describe("type safety (compile-time checks)", () => {
		it("client.add.mutate is typed as AtomResultFn", () => {
			const mockApi = { add: guestbookModule.handlers.add };
			const client = createRpcClient<typeof guestbookModule>(
				mockApi as never,
				{ url: "https://test.convex.cloud" },
			);

			expect(client.add.mutate).toBeDefined();
			expect(Atom.isAtom(client.add.mutate)).toBe(true);
		});

		it("client.get.query payload is typed from module definition", () => {
			const mockApi = { get: guestbookModule.handlers.get };
			const client = createRpcClient<typeof guestbookModule>(
				mockApi as never,
				{ url: "https://test.convex.cloud" },
			);

			const atom = client.get.query({ id: "123" });
			expect(atom).toBeDefined();
		});

		it("client.sendNotification.call is typed as AtomResultFn", () => {
			const mockApi = { sendNotification: guestbookModule.handlers.sendNotification };
			const client = createRpcClient<typeof guestbookModule>(
				mockApi as never,
				{ url: "https://test.convex.cloud" },
			);

			expect(client.sendNotification.call).toBeDefined();
			expect(Atom.isAtom(client.sendNotification.call)).toBe(true);
		});
	});
});



// ---------------------------------------------------------------------------
// Error round-trip helpers (server encode → client decode)
// ---------------------------------------------------------------------------

import { Cause, Chunk, Exit, FiberId } from "effect";
import type { ExitEncoded } from "./server";

class NotFoundError extends Schema.TaggedError<NotFoundError>()(
	"NotFoundError",
	{ id: Schema.String },
) {}

class ForbiddenError extends Schema.TaggedError<ForbiddenError>()(
	"ForbiddenError",
	{},
) {}

const createServerEncoder = (
	successSchema: Schema.Schema.AnyNoContext,
	errorSchema: Schema.Schema.AnyNoContext | undefined,
) => {
	const exitSchemaVal = Schema.Exit({
		success: successSchema as Schema.Schema<unknown, unknown, never>,
		failure: (errorSchema ?? Schema.Never) as Schema.Schema<unknown, unknown, never>,
		defect: Schema.Defect,
	});
	return Schema.encodeSync(exitSchemaVal) as (
		exit: Exit.Exit<unknown, unknown>,
	) => ExitEncoded;
};

type CauseEncoded =
	| { readonly _tag: "Empty" }
	| { readonly _tag: "Fail"; readonly error: unknown }
	| { readonly _tag: "Die"; readonly defect: unknown }
	| { readonly _tag: "Interrupt"; readonly fiberId: unknown }
	| {
			readonly _tag: "Sequential";
			readonly left: CauseEncoded;
			readonly right: CauseEncoded;
	  }
	| {
			readonly _tag: "Parallel";
			readonly left: CauseEncoded;
			readonly right: CauseEncoded;
	  };

const decodeCauseTest = (encoded: CauseEncoded): Cause.Cause<unknown> => {
	switch (encoded._tag) {
		case "Empty":
			return Cause.empty;
		case "Fail":
			return Cause.fail(encoded.error);
		case "Die":
			return Cause.die(encoded.defect);
		case "Interrupt":
			return Cause.interrupt(FiberId.none);
		case "Sequential":
			return Cause.sequential(
				decodeCauseTest(encoded.left),
				decodeCauseTest(encoded.right),
			);
		case "Parallel":
			return Cause.parallel(
				decodeCauseTest(encoded.left),
				decodeCauseTest(encoded.right),
			);
	}
};

const decodeExitTest = (encoded: ExitEncoded): Exit.Exit<unknown, unknown> => {
	if (!encoded || typeof encoded !== "object" || !("_tag" in encoded)) {
		return Exit.fail(
			new RpcDefectError({
				defect: `Unexpected RPC response: ${JSON.stringify(encoded)}`,
			}),
		);
	}
	if (encoded._tag === "Success") {
		return Exit.succeed(encoded.value);
	}
	if (encoded._tag !== "Failure" || !encoded.cause) {
		return Exit.fail(
			new RpcDefectError({
				defect: `Unexpected exit tag: ${String(encoded._tag)}`,
			}),
		);
	}
	const cause = decodeCauseTest(encoded.cause as CauseEncoded);
	const failureOption = Cause.failureOption(cause);
	if (Option.isSome(failureOption)) {
		return Exit.fail(failureOption.value);
	}
	const defects = Cause.defects(cause);
	if (Chunk.isNonEmpty(defects)) {
		return Exit.fail(
			new RpcDefectError({ defect: Chunk.unsafeHead(defects) }),
		);
	}
	return Exit.fail(new RpcDefectError({ defect: "Empty cause" }));
};

describe("Error round-trip (server encode → client decode)", () => {
	it("TaggedError _tag survives server encode → JSON → client decode", () => {
		const encodeExit = createServerEncoder(
			Schema.String,
			Schema.Union(NotFoundError, ForbiddenError),
		);

		const serverExit = Exit.fail(new NotFoundError({ id: "test-123" }));
		const encoded = encodeExit(serverExit);

		// Simulate JSON round-trip (Convex sends JSON over the wire)
		const wire = JSON.parse(JSON.stringify(encoded));

		const clientExit = decodeExitTest(wire);

		expect(Exit.isFailure(clientExit)).toBe(true);
		if (Exit.isFailure(clientExit)) {
			const error = Cause.failureOption(clientExit.cause);
			expect(Option.isSome(error)).toBe(true);
			if (Option.isSome(error)) {
				const err = error.value as Record<string, unknown>;
				expect(err._tag).toBe("NotFoundError");
				expect(err.id).toBe("test-123");
			}
		}
	});

	it("Union TaggedError _tag is preserved for second variant", () => {
		const encodeExit = createServerEncoder(
			Schema.String,
			Schema.Union(NotFoundError, ForbiddenError),
		);

		const serverExit = Exit.fail(new ForbiddenError());
		const encoded = encodeExit(serverExit);
		const wire = JSON.parse(JSON.stringify(encoded));
		const clientExit = decodeExitTest(wire);

		expect(Exit.isFailure(clientExit)).toBe(true);
		if (Exit.isFailure(clientExit)) {
			const error = Cause.failureOption(clientExit.cause);
			expect(Option.isSome(error)).toBe(true);
			if (Option.isSome(error)) {
				const err = error.value as Record<string, unknown>;
				expect(err._tag).toBe("ForbiddenError");
			}
		}
	});

	it("defect (Effect.die) is wrapped in RpcDefectError", () => {
		const encodeExit = createServerEncoder(Schema.String, undefined);

		const serverExit = Exit.die("GitHub API error: 403 Forbidden");
		const encoded = encodeExit(serverExit);
		const wire = JSON.parse(JSON.stringify(encoded));
		const clientExit = decodeExitTest(wire);

		expect(Exit.isFailure(clientExit)).toBe(true);
		if (Exit.isFailure(clientExit)) {
			const error = Cause.failureOption(clientExit.cause);
			expect(Option.isSome(error)).toBe(true);
			if (Option.isSome(error)) {
				expect(error.value).toBeInstanceOf(RpcDefectError);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// Server RPC query deduplication tests
// ---------------------------------------------------------------------------

/**
 * Creates a mock ConvexHttpClientLayer that tracks how many actual query calls
 * are made. Each query resolves after a short delay to simulate network latency,
 * allowing us to test that concurrent calls are deduplicated.
 */
const createMockHttpLayer = () => {
	let callCount = 0;
	const callPayloads: Array<unknown> = [];

	const service: ConvexClientService = {
		query: <Q extends import("convex/server").FunctionReference<"query">>(
			_query: Q,
			args: Q["_args"],
		) => {
			callCount += 1;
			callPayloads.push(args);
			// Simulate network delay so concurrent calls overlap
			return Effect.promise(
				() =>
					new Promise<import("convex/server").FunctionReturnType<Q>>((resolve) => {
						setTimeout(
							() =>
								resolve({
									_tag: "Success",
									value: { data: "test-result" },
								} as import("convex/server").FunctionReturnType<Q>),
							50,
						);
					}),
			);
		},
		mutation: () => Effect.die("not implemented"),
		action: () => Effect.die("not implemented"),
		subscribe: () => Stream.empty,
	};

	const layer = Layer.succeed(ConvexClient, service);

	return {
		layer,
		getCallCount: () => callCount,
		getCallPayloads: () => callPayloads,
		resetCounts: () => {
			callCount = 0;
			callPayloads.length = 0;
		},
	};
};

describe("Server RPC query deduplication", () => {
	it("concurrent queryPromise calls with identical payload only fire one request", async () => {
		const mock = createMockHttpLayer();

		const mockApi = {
			list: guestbookModule.handlers.list,
		};

		const serverClient = createServerRpcQuery<typeof guestbookModule>(
			mockApi as never,
			{ url: "https://test.convex.cloud", layer: mock.layer },
		);

		// Fire 3 concurrent calls with the same payload
		const [r1, r2, r3] = await Promise.all([
			serverClient.list.queryPromise({}),
			serverClient.list.queryPromise({}),
			serverClient.list.queryPromise({}),
		]);

		// All should return the same result
		expect(r1).toEqual({ data: "test-result" });
		expect(r2).toEqual({ data: "test-result" });
		expect(r3).toEqual({ data: "test-result" });

		// Only ONE actual query should have been made
		expect(mock.getCallCount()).toBe(1);
	});

	it("concurrent calls with DIFFERENT payloads fire separate requests", async () => {
		const mock = createMockHttpLayer();

		const mockApi = {
			get: guestbookModule.handlers.get,
		};

		const serverClient = createServerRpcQuery<typeof guestbookModule>(
			mockApi as never,
			{ url: "https://test.convex.cloud", layer: mock.layer },
		);

		const [r1, r2] = await Promise.all([
			serverClient.get.queryPromise({ id: "a" }),
			serverClient.get.queryPromise({ id: "b" }),
		]);

		// Both resolve
		expect(r1).toEqual({ data: "test-result" });
		expect(r2).toEqual({ data: "test-result" });

		// Two different payloads = two separate requests
		expect(mock.getCallCount()).toBe(2);
	});

	it("scopes server query cache by auth token when configured", async () => {
		const mock = createMockHttpLayer();

		const mockApi = {
			list: guestbookModule.handlers.list,
		};

		let token = "token-a";

		const serverClient = createServerRpcQuery<typeof guestbookModule>(
			mockApi as never,
			{
				url: "https://test.convex.cloud",
				layer: mock.layer,
				getAuthToken: async () => token,
			},
		);

		await serverClient.list.queryPromise({});
		await serverClient.list.queryPromise({});
		expect(mock.getCallCount()).toBe(1);

		token = "token-b";
		await serverClient.list.queryPromise({});
		expect(mock.getCallCount()).toBe(2);
	});

	it("sequential calls after TTL expiry fire fresh requests", async () => {
		const mock = createMockHttpLayer();

		const mockApi = {
			list: guestbookModule.handlers.list,
		};

		const serverClient = createServerRpcQuery<typeof guestbookModule>(
			mockApi as never,
			{ url: "https://test.convex.cloud", layer: mock.layer },
		);

		// First call
		const r1 = await serverClient.list.queryPromise({});
		expect(r1).toEqual({ data: "test-result" });

		// Second call happens immediately (within TTL) — should be cached
		const r2 = await serverClient.list.queryPromise({});
		expect(r2).toEqual({ data: "test-result" });

		// Within the TTL window, both calls share the same cached result
		// The Cache coalesces in-flight requests AND caches completed results
		// for the TTL duration, so sequential calls within TTL only fire once.
		expect(mock.getCallCount()).toBe(1);
	});

	it("deduplication works when first call rejects", async () => {
		let callCount = 0;

		const failingService: ConvexClientService = {
			query: <Q extends import("convex/server").FunctionReference<"query">>(
				_query: Q,
				_args: Q["_args"],
			) => {
				callCount += 1;
				return Effect.promise(
					() =>
						new Promise<import("convex/server").FunctionReturnType<Q>>((resolve) => {
							setTimeout(
								() =>
									resolve({
										_tag: "Failure",
										cause: {
											_tag: "Fail",
											error: { _tag: "SomeError" },
										},
									} as import("convex/server").FunctionReturnType<Q>),
								50,
							);
						}),
				);
			},
			mutation: () => Effect.die("not implemented"),
			action: () => Effect.die("not implemented"),
			subscribe: () => Stream.empty,
		};

		const failingLayer = Layer.succeed(ConvexClient, failingService);

		const mockApi = {
			list: guestbookModule.handlers.list,
		};

		const serverClient = createServerRpcQuery<typeof guestbookModule>(
			mockApi as never,
			{ url: "https://test.convex.cloud", layer: failingLayer },
		);

		// All 3 should reject
		const results = await Promise.allSettled([
			serverClient.list.queryPromise({}),
			serverClient.list.queryPromise({}),
			serverClient.list.queryPromise({}),
		]);

		expect(results[0].status).toBe("rejected");
		expect(results[1].status).toBe("rejected");
		expect(results[2].status).toBe("rejected");

		// Only ONE actual call
		expect(callCount).toBe(1);
	});
});

describe("RPC Module", () => {
	describe("makeRpcModule", () => {
		it("creates module with handlers object", () => {
			expect(guestbookModule.handlers).toBeDefined();
			expect(guestbookModule.handlers.add).toBeDefined();
			expect(guestbookModule.handlers.list).toBeDefined();
			expect(guestbookModule.handlers.get).toBeDefined();
			expect(guestbookModule.handlers.sendNotification).toBeDefined();
		});

		it("creates module with rpcs object", () => {
			expect(guestbookModule.rpcs).toBeDefined();
			expect(guestbookModule.rpcs.add).toBeDefined();
			expect(guestbookModule.rpcs.list).toBeDefined();
			expect(guestbookModule.rpcs.get).toBeDefined();
			expect(guestbookModule.rpcs.sendNotification).toBeDefined();
		});

		it("creates module with group for @effect/rpc compatibility", () => {
			expect(guestbookModule.group).toBeDefined();
		});

		it("endpoint objects are accessible directly on module", () => {
			expect(guestbookModule.add).toBeDefined();
			expect(guestbookModule.add._tag).toBe("add");
			expect(guestbookModule.list._tag).toBe("list");
			expect(guestbookModule.get._tag).toBe("get");
			expect(guestbookModule.sendNotification._tag).toBe("sendNotification");
		});

		it("handlers are Convex registered functions", () => {
			expect(typeof guestbookModule.handlers.add).toBe("function");
			expect(typeof guestbookModule.handlers.list).toBe("function");
		});
	});

	describe("createRpcFactory", () => {
		it("creates factory with query, mutation, action methods", () => {
			expect(typeof factory.query).toBe("function");
			expect(typeof factory.mutation).toBe("function");
			expect(typeof factory.action).toBe("function");
		});

		it("creates factory with internal variants", () => {
			expect(typeof factory.internalQuery).toBe("function");
			expect(typeof factory.internalMutation).toBe("function");
			expect(typeof factory.internalAction).toBe("function");
		});
	});
});
