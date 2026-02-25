import { describe, expect, it, vi } from "vitest";
import { Effect, Schema, Context, Layer } from "effect";
import { Rpc, RpcMiddleware } from "@effect/rpc";
import {
	createRpcFactory,
	makeRpcModule,
	exitSchema,
	fork,
	uninterruptible,
	isWrapper,
	wrap,
	type ExitEncoded,
} from "./server";
import { defineSchema, defineTable } from "../schema";

const testSchema = defineSchema({
	items: defineTable(
		Schema.Struct({
			name: Schema.String,
			value: Schema.Number,
		}),
	),
});

const createMockCtx = () => ({
	db: {
		query: vi.fn(),
		get: vi.fn(),
		insert: vi.fn(),
		patch: vi.fn(),
		replace: vi.fn(),
		delete: vi.fn(),
		normalizeId: vi.fn(),
	},
	auth: {
		getUserIdentity: vi.fn().mockResolvedValue(null),
	},
	runQuery: vi.fn(),
	runMutation: vi.fn(),
	runAction: vi.fn(),
	scheduler: {
		runAfter: vi.fn(),
		runAt: vi.fn(),
	},
});

type ConvexHandlerInternal = (ctx: unknown, args: unknown) => Promise<ExitEncoded>;

const getHandler = (handler: unknown): ConvexHandlerInternal => {
	const h = handler as { _handler: (ctx: unknown, args: unknown) => Promise<ExitEncoded> };
	return h._handler;
};

type SuccessExit = { readonly _tag: "Success"; readonly value: unknown };
type FailureExit = { readonly _tag: "Failure"; readonly cause: unknown };

const assertSuccess = (exit: ExitEncoded): SuccessExit => {
	if (exit._tag !== "Success") {
		throw new Error(`Expected Success exit, got ${exit._tag}`);
	}
	return exit as SuccessExit;
};

const assertFailure = (exit: ExitEncoded): FailureExit => {
	if (exit._tag !== "Failure") {
		throw new Error(`Expected Failure exit, got ${exit._tag}`);
	}
	return exit as FailureExit;
};

/** Helper: define + immediately implement an endpoint (convenience for tests) */
const withImpl = <T extends { implement: (handler: (...args: ReadonlyArray<never>) => Effect.Effect<never, never, never>) => void }>(
	endpoint: T,
	handler: Parameters<T["implement"]>[0],
): T => {
	endpoint.implement(handler);
	return endpoint;
};

describe("RPC Server", () => {
	describe("createRpcFactory", () => {
		it("creates a factory with query, mutation, and action methods", () => {
			const factory = createRpcFactory({ schema: testSchema });

			expect(factory.query).toBeDefined();
			expect(factory.mutation).toBeDefined();
			expect(factory.action).toBeDefined();
			expect(factory.internalQuery).toBeDefined();
			expect(factory.internalMutation).toBeDefined();
			expect(factory.internalAction).toBeDefined();
		});

		describe("query endpoint", () => {
			it("creates a query endpoint with success schema", () => {
				const factory = createRpcFactory({ schema: testSchema });

				const endpoint = factory.query({ success: Schema.String });

				expect(endpoint.__unbuilt).toBe(true);
				expect(endpoint.kind).toBe("query");
				expect(endpoint.successSchema).toBe(Schema.String);
			});

			it("creates a query endpoint with payload", () => {
				const factory = createRpcFactory({ schema: testSchema });

				const endpoint = factory.query({
					payload: { name: Schema.String },
					success: Schema.String,
				});

				expect(endpoint.__unbuilt).toBe(true);
				expect(endpoint.payloadFields).toHaveProperty("name");
			});

			it("creates a query endpoint with error schema", () => {
				class CustomError extends Schema.TaggedError<CustomError>()(
					"CustomError",
					{ message: Schema.String },
				) {}

				const factory = createRpcFactory({ schema: testSchema });

				const endpoint = factory.query({
					success: Schema.String,
					error: CustomError,
				});

				expect(endpoint.__unbuilt).toBe(true);
				expect(endpoint.errorSchema).toBe(CustomError);
			});
		});

		describe("mutation endpoint", () => {
			it("creates a mutation endpoint", () => {
				const factory = createRpcFactory({ schema: testSchema });

				const endpoint = factory.mutation({
					payload: { value: Schema.Number },
					success: Schema.Boolean,
				});

				expect(endpoint.__unbuilt).toBe(true);
				expect(endpoint.kind).toBe("mutation");
			});
		});

		describe("action endpoint", () => {
			it("creates an action endpoint", () => {
				const factory = createRpcFactory({ schema: testSchema });

				const endpoint = factory.action({ success: Schema.Void });

				expect(endpoint.__unbuilt).toBe(true);
				expect(endpoint.kind).toBe("action");
			});
		});

		describe("internal endpoints", () => {
			it("creates internal query endpoint", () => {
				const factory = createRpcFactory({ schema: testSchema });

				const endpoint = factory.internalQuery({ success: Schema.Number });

				expect(endpoint.__unbuilt).toBe(true);
				expect(endpoint.kind).toBe("internalQuery");
			});

			it("creates internal mutation endpoint", () => {
				const factory = createRpcFactory({ schema: testSchema });

				const endpoint = factory.internalMutation({ success: Schema.Void });

				expect(endpoint.__unbuilt).toBe(true);
				expect(endpoint.kind).toBe("internalMutation");
			});

			it("creates internal action endpoint", () => {
				const factory = createRpcFactory({ schema: testSchema });

				const endpoint = factory.internalAction({ success: Schema.String });

				expect(endpoint.__unbuilt).toBe(true);
				expect(endpoint.kind).toBe("internalAction");
			});
		});
	});

	describe("makeRpcModule", () => {
		it("builds endpoints with correct tags", () => {
			const factory = createRpcFactory({ schema: testSchema });

			const getItems = factory.query({ success: Schema.Array(Schema.String) });
			getItems.implement(() => Effect.succeed([]));

			const addItem = factory.mutation({
				payload: { name: Schema.String },
				success: Schema.String,
			});
			addItem.implement((args) => Effect.succeed(args.name));

			const module = makeRpcModule({ getItems, addItem });

			expect(module.getItems._tag).toBe("getItems");
			expect(module.addItem._tag).toBe("addItem");
		});

		it("provides handlers for each endpoint", () => {
			const factory = createRpcFactory({ schema: testSchema });

			const echo = factory.query({
				payload: { message: Schema.String },
				success: Schema.String,
			});
			echo.implement((args) => Effect.succeed(args.message));

			const module = makeRpcModule({ echo });

			expect(module.handlers.echo).toBeDefined();
		});

		it("provides rpcs for each endpoint", () => {
			const factory = createRpcFactory({ schema: testSchema });

			const myQuery = factory.query({ success: Schema.Void });
			myQuery.implement(() => Effect.void);

			const module = makeRpcModule({ myQuery });

			expect(module.rpcs.myQuery).toBeDefined();
		});

		it("provides a group for all rpcs", () => {
			const factory = createRpcFactory({ schema: testSchema });

			const first = factory.query({ success: Schema.String });
			first.implement(() => Effect.succeed("1"));

			const second = factory.query({ success: Schema.Number });
			second.implement(() => Effect.succeed(2));

			const module = makeRpcModule({ first, second });

			expect(module.group).toBeDefined();
		});
	});

	describe("basePayload", () => {
		it("merges base payload with endpoint payload", () => {
			const factory = createRpcFactory({
				schema: testSchema,
				basePayload: {
					tenantId: Schema.String,
				},
			});

			const endpoint = factory.query({
				payload: { itemId: Schema.String },
				success: Schema.Void,
			});
			endpoint.implement((args) => {
				expect(args.tenantId).toBeDefined();
				expect(args.itemId).toBeDefined();
				return Effect.void;
			});

			expect(endpoint.payloadFields).toHaveProperty("tenantId");
			expect(endpoint.payloadFields).toHaveProperty("itemId");
		});
	});

	describe("ExitEncoded format", () => {
		const factory = createRpcFactory({ schema: testSchema });

		it("encodes success correctly", async () => {
			const test = factory.query({ success: Schema.String });
			test.implement(() => Effect.succeed("hello"));

			const module = makeRpcModule({ test });

			const ctx = createMockCtx();
			const handler = getHandler(module.handlers.test);
			const result = await handler(ctx, {});

			const success = assertSuccess(result);
			expect(success.value).toBe("hello");
		});

		it("encodes failure correctly", async () => {
			class TestError extends Schema.TaggedError<TestError>()("TestError", {
				code: Schema.Number,
			}) {}

			const test = factory.query({ success: Schema.String, error: TestError });
			test.implement(() => Effect.fail(new TestError({ code: 500 })));

			const module = makeRpcModule({ test });

			const ctx = createMockCtx();
			const handler = getHandler(module.handlers.test);
			const result = await handler(ctx, {});

			const failure = assertFailure(result);
			expect(failure.cause).toEqual({
				_tag: "Fail",
				error: { _tag: "TestError", code: 500 },
			});
		});

		it("encodes defects (thrown errors) correctly", async () => {
			const test = factory.query({ success: Schema.Void });
			test.implement(() => Effect.die(new Error("unexpected error")));

			const module = makeRpcModule({ test });

			const ctx = createMockCtx();
			const handler = getHandler(module.handlers.test);
			const result = await handler(ctx, {});

			const failure = assertFailure(result);
			expect(failure.cause).toMatchObject({
				_tag: "Die",
				defect: {
					name: "Error",
					message: "unexpected error",
				},
			});
		});

		it("handles payload decode errors as defects", async () => {
			const test = factory.query({
				payload: { num: Schema.Number },
				success: Schema.Void,
			});
			test.implement(() => Effect.void);

			const module = makeRpcModule({ test });

			const ctx = createMockCtx();
			const handler = getHandler(module.handlers.test);
			const result = await handler(ctx, { num: "not a number" });

			const failure = assertFailure(result);
			expect(failure.cause).toHaveProperty("_tag", "Die");
		});
	});

	describe("complex success/error schemas", () => {
		const factory = createRpcFactory({ schema: testSchema });

		it("handles array success schema", async () => {
			const ItemSchema = Schema.Struct({
				id: Schema.String,
				name: Schema.String,
			});

			const getItems = factory.query({ success: Schema.Array(ItemSchema) });
			getItems.implement(() =>
				Effect.succeed([
					{ id: "1", name: "Item 1" },
					{ id: "2", name: "Item 2" },
				]),
			);

			const module = makeRpcModule({ getItems });

			const ctx = createMockCtx();
			const handler = getHandler(module.handlers.getItems);
			const result = await handler(ctx, {});

			const success = assertSuccess(result);
			expect(success.value).toEqual([
				{ id: "1", name: "Item 1" },
				{ id: "2", name: "Item 2" },
			]);
		});

		it("handles union error schema", async () => {
			class NotFoundError extends Schema.TaggedError<NotFoundError>()(
				"NotFoundError",
				{ id: Schema.String },
			) {}

			class ForbiddenError extends Schema.TaggedError<ForbiddenError>()(
				"ForbiddenError",
				{},
			) {}

			const ErrorSchema = Schema.Union(NotFoundError, ForbiddenError);

			const getItem = factory.query({
				payload: { id: Schema.String },
				success: Schema.Void,
				error: ErrorSchema,
			});
			getItem.implement((args) =>
				Effect.fail(new NotFoundError({ id: args.id })),
			);

			const module = makeRpcModule({ getItem });

			const ctx = createMockCtx();
			const handler = getHandler(module.handlers.getItem);
			const result = await handler(ctx, { id: "123" });

			const failure = assertFailure(result);
			expect(failure.cause).toEqual({
				_tag: "Fail",
				error: { _tag: "NotFoundError", id: "123" },
			});
		});

		it("handles optional fields in payload", async () => {
			const search = factory.query({
				payload: {
					query: Schema.String,
					limit: Schema.optional(Schema.Number),
				},
				success: Schema.Array(Schema.String),
			});
			search.implement((args) => {
				const limit = args.limit ?? 10;
				return Effect.succeed(
					Array(limit)
						.fill(null)
						.map((_, i) => `${args.query}-${i}`),
				);
			});

			const module = makeRpcModule({ search });

			const ctx = createMockCtx();
			const handler = getHandler(module.handlers.search);

			const resultWithLimit = await handler(ctx, {
				query: "test",
				limit: 3,
			});
			const successWithLimit = assertSuccess(resultWithLimit);
			expect((successWithLimit.value as Array<string>).length).toBe(3);

			const resultWithoutLimit = await handler(ctx, {
				query: "test",
			});
			const successWithoutLimit = assertSuccess(resultWithoutLimit);
			expect((successWithoutLimit.value as Array<string>).length).toBe(10);
		});
	});

	describe("middleware", () => {
		class CurrentUser extends Context.Tag("CurrentUser")<
			CurrentUser,
			{ id: string; name: string }
		>() {}

		class AuthMiddleware extends RpcMiddleware.Tag<AuthMiddleware>()(
			"AuthMiddleware",
			{
				provides: CurrentUser,
			},
		) {}

	it("provides service from middleware via Layer", async () => {
		const factory = createRpcFactory({ schema: testSchema });

		const CurrentUserLive = Layer.succeed(
			CurrentUser,
			{ id: "user-123", name: "Test User" },
		);

		const whoami = factory.query({ success: Schema.String });
		whoami.implement(() =>
			Effect.gen(function* () {
				const user = yield* CurrentUser;
				return `Hello, ${user.name}!`;
			}),
		);

		const module = makeRpcModule(
			{
				whoami: whoami.middleware(AuthMiddleware),
			},
			{ middlewares: CurrentUserLive },
		);

		const ctx = createMockCtx();
		const handler = getHandler(module.handlers.whoami);
		const result = await handler(ctx, {});

		const success = assertSuccess(result);
		expect(success.value).toBe("Hello, Test User!");
	});

	it("handler can access payload and middleware services", async () => {
		let receivedItemId: string | null = null;

		const factory = createRpcFactory({ schema: testSchema });

		const CurrentUserLive = Layer.succeed(
			CurrentUser,
			{ id: "user-123", name: "Test User" },
		);

		const test = factory.query({
			payload: { itemId: Schema.String },
			success: Schema.String,
		});
		test.implement((args) =>
			Effect.gen(function* () {
				receivedItemId = args.itemId;
				const user = yield* CurrentUser;
				return `${user.name} accessed ${args.itemId}`;
			}),
		);

		const module = makeRpcModule(
			{
				test: test.middleware(AuthMiddleware),
			},
			{ middlewares: CurrentUserLive },
		);

		const ctx = createMockCtx();
		const handler = getHandler(module.handlers.test);
		const result = await handler(ctx, { itemId: "item-456" });

		const success = assertSuccess(result);
		expect(receivedItemId).toEqual("item-456");
		expect(success.value).toBe("Test User accessed item-456");
	});

	it("layer failure is encoded correctly", async () => {
		class AuthError extends Schema.TaggedError<AuthError>()("AuthError", {
			reason: Schema.String,
		}) {}

		class FailingAuthMiddleware extends RpcMiddleware.Tag<FailingAuthMiddleware>()(
			"FailingAuthMiddleware",
			{
				provides: CurrentUser,
				failure: AuthError,
			},
		) {}

		const factory = createRpcFactory({ schema: testSchema });

		const FailingAuthLive = Layer.fail(new AuthError({ reason: "Invalid token" }));

		const protectedEndpoint = factory.query({
			success: Schema.String,
			error: AuthError,
		});
		protectedEndpoint.implement(() =>
			Effect.gen(function* () {
				yield* CurrentUser;
				return "secret";
			}),
		);

		const module = makeRpcModule(
			{
				protected: protectedEndpoint.middleware(FailingAuthMiddleware),
			},
			{ middlewares: FailingAuthLive },
		);

		const ctx = createMockCtx();
		const handler = getHandler(module.handlers.protected);
		const result = await handler(ctx, {});

		const failure = assertFailure(result);
		expect(failure.cause).toMatchObject({
			_tag: "Fail",
			error: { _tag: "AuthError", reason: "Invalid token" },
		});
	});

	it("multiple services are provided via merged Layers", async () => {
		const executionOrder: Array<string> = [];

		class Logger extends Context.Tag("Logger")<Logger, { log: (msg: string) => void }>() {}

		class LoggerMiddleware extends RpcMiddleware.Tag<LoggerMiddleware>()(
			"LoggerMiddleware",
			{
				provides: Logger,
			},
		) {}

		const factory = createRpcFactory({ schema: testSchema });

		const CurrentUserLive = Layer.succeed(
			CurrentUser,
			{ id: "user-123", name: "Test User" },
		);

		const LoggerLive = Layer.succeed(
			Logger,
			{ log: (msg: string) => executionOrder.push(`log:${msg}`) },
		);

		const ServicesLive = Layer.mergeAll(CurrentUserLive, LoggerLive);

		const test = factory.query({ success: Schema.String });
		test.implement(() =>
			Effect.gen(function* () {
				const user = yield* CurrentUser;
				const logger = yield* Logger;
				logger.log("accessed");
				return user.name;
			}),
		);

		const module = makeRpcModule(
			{
				test: test
					.middleware(AuthMiddleware)
					.middleware(LoggerMiddleware),
			},
			{ middlewares: ServicesLive },
		);

		const ctx = createMockCtx();
		const handler = getHandler(module.handlers.test);
		const result = await handler(ctx, {});

		const success = assertSuccess(result);
		expect(success.value).toBe("Test User");
		expect(executionOrder).toContain("log:accessed");
	});

		it("works without any middleware", async () => {
			const factory = createRpcFactory({ schema: testSchema });

			const simple = factory.query({ success: Schema.Number });
			simple.implement(() => Effect.succeed(42));

			const module = makeRpcModule({ simple });

			const ctx = createMockCtx();
			const handler = getHandler(module.handlers.simple);
			const result = await handler(ctx, {});

			const success = assertSuccess(result);
			expect(success.value).toBe(42);
		});
	});

	describe("security and error encoding", () => {
		const factory = createRpcFactory({ schema: testSchema });

		it("does not expose error stack traces in defects", async () => {
			const test = factory.query({ success: Schema.Void });
			test.implement(() => {
				const error = new Error("Internal error with sensitive info");
				error.stack = "Error: Internal error\n  at secret/path/to/file.ts:42:13";
				return Effect.die(error);
			});

			const module = makeRpcModule({ test });

			const ctx = createMockCtx();
			const handler = getHandler(module.handlers.test);
			const result = await handler(ctx, {});

			const failure = assertFailure(result);
			expect(failure.cause).toMatchObject({
				_tag: "Die",
				defect: {
					name: "Error",
					message: "Internal error with sensitive info",
				},
			});
			const causeStr = JSON.stringify(failure.cause);
			expect(causeStr).not.toContain("stack");
			expect(causeStr).not.toContain("secret/path");
		});

		it("serializes non-Error defects safely", async () => {
			const test = factory.query({ success: Schema.Void });
			test.implement(() => Effect.die("raw string error"));

			const module = makeRpcModule({ test });

			const ctx = createMockCtx();
			const handler = getHandler(module.handlers.test);
			const result = await handler(ctx, {});

			const failure = assertFailure(result);
			expect(failure.cause).toMatchObject({
				_tag: "Die",
				defect: "raw string error",
			});
		});

		it("serializes object defects as JSON strings", async () => {
			const test = factory.query({ success: Schema.Void });
			test.implement(() =>
				Effect.die({ _tag: "CustomDefect", code: 500, details: "some details" }),
			);

			const module = makeRpcModule({ test });

			const ctx = createMockCtx();
			const handler = getHandler(module.handlers.test);
			const result = await handler(ctx, {});

			const failure = assertFailure(result);
			expect(failure.cause).toMatchObject({
				_tag: "Die",
			});
			expect(typeof (failure.cause as { defect: unknown }).defect).toBe("string");
			expect((failure.cause as { defect: string }).defect).toContain("CustomDefect");
		});

		it("encodes interrupt cause correctly", async () => {
			const test = factory.query({ success: Schema.Void });
			test.implement(() => Effect.interrupt);

			const module = makeRpcModule({ test });

			const ctx = createMockCtx();
			const handler = getHandler(module.handlers.test);
			const result = await handler(ctx, {});

			const failure = assertFailure(result);
			expect(failure.cause).toHaveProperty("_tag", "Interrupt");
		});

		it("encodes tagged errors with their schema", async () => {
			class ValidationError extends Schema.TaggedError<ValidationError>()(
				"ValidationError",
				{
					field: Schema.String,
					message: Schema.String,
				},
			) {}

			const test = factory.query({
				success: Schema.Void,
				error: ValidationError,
			});
			test.implement(() =>
				Effect.fail(new ValidationError({ field: "email", message: "Invalid format" })),
			);

			const module = makeRpcModule({ test });

			const ctx = createMockCtx();
			const handler = getHandler(module.handlers.test);
			const result = await handler(ctx, {});

			const failure = assertFailure(result);
			expect(failure.cause).toMatchObject({
				_tag: "Fail",
				error: {
					_tag: "ValidationError",
					field: "email",
					message: "Invalid format",
				},
			});
		});

		it("handles thrown sync exceptions as defects", async () => {
			const test = factory.query({ success: Schema.Void });
			test.implement(() =>
				Effect.sync(() => {
					throw new Error("Sync throw");
				}),
			);

			const module = makeRpcModule({ test });

			const ctx = createMockCtx();
			const handler = getHandler(module.handlers.test);
			const result = await handler(ctx, {});

			const failure = assertFailure(result);
			expect(failure.cause).toMatchObject({
				_tag: "Die",
				defect: {
					name: "Error",
					message: "Sync throw",
				},
			});
		});

		it("handles promise rejections as defects", async () => {
			const test = factory.query({ success: Schema.Void });
			test.implement(() =>
				Effect.promise(() => Promise.reject(new Error("Promise rejection"))),
			);

			const module = makeRpcModule({ test });

			const ctx = createMockCtx();
			const handler = getHandler(module.handlers.test);
			const result = await handler(ctx, {});

			const failure = assertFailure(result);
			expect(failure.cause).toMatchObject({
				_tag: "Die",
				defect: {
					name: "Error",
					message: "Promise rejection",
				},
			});
		});

		it("encodes nested error structures properly", async () => {
			class OuterError extends Schema.TaggedError<OuterError>()("OuterError", {
				inner: Schema.Struct({
					code: Schema.Number,
					details: Schema.Array(Schema.String),
				}),
			}) {}

			const test = factory.query({
				success: Schema.Void,
				error: OuterError,
			});
			test.implement(() =>
				Effect.fail(
					new OuterError({
						inner: {
							code: 422,
							details: ["Field 1 invalid", "Field 2 missing"],
						},
					}),
				),
			);

			const module = makeRpcModule({ test });

			const ctx = createMockCtx();
			const handler = getHandler(module.handlers.test);
			const result = await handler(ctx, {});

			const failure = assertFailure(result);
			expect(failure.cause).toMatchObject({
				_tag: "Fail",
				error: {
					_tag: "OuterError",
					inner: {
						code: 422,
						details: ["Field 1 invalid", "Field 2 missing"],
					},
				},
			});
		});
	});

	describe("@effect/rpc API compatibility", () => {
		describe("exitSchema", () => {
			it("returns exit schema for an RPC", () => {
				const rpc = Rpc.make("TestRpc", {
					payload: { id: Schema.String },
					success: Schema.Number,
					error: Schema.String,
				});

				const schema = exitSchema(rpc);
				expect(schema).toBeDefined();
			});
		});

		describe("wrapper utilities", () => {
			it("fork wraps an Effect", () => {
				const effect = Effect.succeed(42);
				const wrapped = fork(effect);
				
				expect(isWrapper(wrapped)).toBe(true);
				expect(wrapped.fork).toBe(true);
				expect(wrapped.value).toBe(effect);
			});

			it("uninterruptible wraps an Effect", () => {
				const effect = Effect.succeed(42);
				const wrapped = uninterruptible(effect);
				
				expect(isWrapper(wrapped)).toBe(true);
				expect(wrapped.uninterruptible).toBe(true);
				expect(wrapped.value).toBe(effect);
			});

			it("wrap with custom options", () => {
				const effect = Effect.succeed(42);
				const wrapped = wrap({ fork: true, uninterruptible: true })(effect);
				
				expect(isWrapper(wrapped)).toBe(true);
				expect(wrapped.fork).toBe(true);
				expect(wrapped.uninterruptible).toBe(true);
			});

			it("isWrapper returns false for non-wrappers", () => {
				expect(isWrapper({})).toBe(false);
				expect(isWrapper({ fork: true })).toBe(false);
			});
		});

	});

	describe("middleware chaining on individual RPCs", () => {
		it("allows chaining .middleware() on individual endpoints", () => {
			class AuthMiddleware extends RpcMiddleware.Tag<AuthMiddleware>()(
				"AuthMiddleware",
				{},
			) {}

			class LoggingMiddleware extends RpcMiddleware.Tag<LoggingMiddleware>()(
				"LoggingMiddleware",
				{},
			) {}

			const factory = createRpcFactory({ schema: testSchema });

			const endpoint = factory
				.query({ success: Schema.String })
				.middleware(AuthMiddleware)
				.middleware(LoggingMiddleware);

			expect(endpoint.__unbuilt).toBe(true);
			expect(endpoint.middlewares).toHaveLength(2);
			expect(endpoint.middlewares[0]).toBe(AuthMiddleware);
			expect(endpoint.middlewares[1]).toBe(LoggingMiddleware);
		});
	});

	describe("per-request middleware execution", () => {
		class CurrentUser extends Context.Tag("CurrentUser")<
			CurrentUser,
			{ id: string; name: string }
		>() {}

		class AuthMiddleware extends RpcMiddleware.Tag<AuthMiddleware>()(
			"AuthMiddleware",
			{
				provides: CurrentUser,
			},
		) {}

		it("executes middleware function per request", async () => {
			const { middleware } = await import("./server");
			const factory = createRpcFactory({ schema: testSchema });
			let callCount = 0;

			const authImpl = middleware(AuthMiddleware, (options) => {
				callCount++;
				return Effect.succeed({ id: `user-${callCount}`, name: `User ${callCount}` });
			});

			const whoami = factory.query({ success: Schema.String });
			whoami.implement(() =>
				Effect.gen(function* () {
					const user = yield* CurrentUser;
					return user.name;
				}),
			);

			const module = makeRpcModule(
				{
					whoami: whoami.middleware(AuthMiddleware),
				},
				{ middlewares: [authImpl] },
			);

			const ctx = createMockCtx();
			const handler = getHandler(module.handlers.whoami);

			const result1 = await handler(ctx, {});
			const success1 = assertSuccess(result1);
			expect(success1.value).toBe("User 1");

			const result2 = await handler(ctx, {});
			const success2 = assertSuccess(result2);
			expect(success2.value).toBe("User 2");

			expect(callCount).toBe(2);
		});

		it("middleware receives payload", async () => {
			const { middleware } = await import("./server");
			const factory = createRpcFactory({ schema: testSchema });
			let receivedPayload: unknown = null;

			const authImpl = middleware(AuthMiddleware, (options) => {
				receivedPayload = options.payload;
				return Effect.succeed({ id: "user-1", name: "Test" });
			});

			const test = factory.query({
				payload: { itemId: Schema.String },
				success: Schema.String,
			});
			test.implement((args) =>
				Effect.gen(function* () {
					const user = yield* CurrentUser;
					return `${user.name} accessed ${args.itemId}`;
				}),
			);

			const module = makeRpcModule(
				{
					test: test.middleware(AuthMiddleware),
				},
				{ middlewares: [authImpl] },
			);

			const ctx = createMockCtx();
			const handler = getHandler(module.handlers.test);
			await handler(ctx, { itemId: "item-456" });

			expect(receivedPayload).toEqual({ itemId: "item-456" });
		});

		it("middleware receives rpc info", async () => {
			const { middleware } = await import("./server");
			const factory = createRpcFactory({ schema: testSchema });
			let receivedRpcInfo: unknown = null;

			const authImpl = middleware(AuthMiddleware, (options) => {
				receivedRpcInfo = options.rpc;
				return Effect.succeed({ id: "user-1", name: "Test" });
			});

			const myEndpoint = factory.query({ success: Schema.String });
			myEndpoint.implement(() =>
				Effect.gen(function* () {
					yield* CurrentUser;
					return "ok";
				}),
			);

			const module = makeRpcModule(
				{
					myEndpoint: myEndpoint.middleware(AuthMiddleware),
				},
				{ middlewares: [authImpl] },
			);

			const ctx = createMockCtx();
			const handler = getHandler(module.handlers.myEndpoint);
			await handler(ctx, {});

			expect(receivedRpcInfo).toEqual({ tag: "myEndpoint", kind: "query" });
		});

		it("middleware receives convex context", async () => {
			const { middleware } = await import("./server");
			const factory = createRpcFactory({ schema: testSchema });
			let receivedCtx: unknown = null;

			const authImpl = middleware(AuthMiddleware, (options) => {
				receivedCtx = options.ctx;
				return Effect.succeed({ id: "user-1", name: "Test" });
			});

			const test = factory.query({ success: Schema.String });
			test.implement(() =>
				Effect.gen(function* () {
					yield* CurrentUser;
					return "ok";
				}),
			);

			const module = makeRpcModule(
				{
					test: test.middleware(AuthMiddleware),
				},
				{ middlewares: [authImpl] },
			);

			const mockCtx = createMockCtx();
			const handler = getHandler(module.handlers.test);
			await handler(mockCtx, {});

			expect(receivedCtx).toBe(mockCtx);
		});

		it("middleware can fail with typed error", async () => {
			const { middleware } = await import("./server");

			class AuthError extends Schema.TaggedError<AuthError>()("AuthError", {
				reason: Schema.String,
			}) {}

			class FailingAuthMiddleware extends RpcMiddleware.Tag<FailingAuthMiddleware>()(
				"FailingAuthMiddleware",
				{
					provides: CurrentUser,
					failure: AuthError,
				},
			) {}

			const factory = createRpcFactory({ schema: testSchema });

			const authImpl = middleware(FailingAuthMiddleware, () =>
				Effect.fail(new AuthError({ reason: "Invalid token" })),
			);

			const protectedEndpoint = factory.query({
				success: Schema.String,
				error: AuthError,
			});
			protectedEndpoint.implement(() =>
				Effect.gen(function* () {
					yield* CurrentUser;
					return "secret";
				}),
			);

			const module = makeRpcModule(
				{
					protected: protectedEndpoint.middleware(FailingAuthMiddleware),
				},
				{ middlewares: [authImpl] },
			);

			const ctx = createMockCtx();
			const handler = getHandler(module.handlers.protected);
			const result = await handler(ctx, {});

			const failure = assertFailure(result);
			expect(failure.cause).toMatchObject({
				_tag: "Fail",
				error: { _tag: "AuthError", reason: "Invalid token" },
			});
		});

		it("multiple per-request middlewares execute in order", async () => {
			const { middleware } = await import("./server");
			const executionOrder: Array<string> = [];

			class Logger extends Context.Tag("Logger")<Logger, { log: (msg: string) => void }>() {}

			class LoggerMiddleware extends RpcMiddleware.Tag<LoggerMiddleware>()(
				"LoggerMiddleware",
				{ provides: Logger },
			) {}

			const factory = createRpcFactory({ schema: testSchema });

			const authImpl = middleware(AuthMiddleware, () => {
				executionOrder.push("auth");
				return Effect.succeed({ id: "user-1", name: "Test" });
			});

			const loggerImpl = middleware(LoggerMiddleware, () => {
				executionOrder.push("logger");
				return Effect.succeed({ log: (msg: string) => executionOrder.push(`log:${msg}`) });
			});

			const test = factory.query({ success: Schema.String });
			test.implement(() =>
				Effect.gen(function* () {
					const user = yield* CurrentUser;
					const logger = yield* Logger;
					logger.log("handler");
					return user.name;
				}),
			);

			const module = makeRpcModule(
				{
					test: test
						.middleware(AuthMiddleware)
						.middleware(LoggerMiddleware),
				},
				{ middlewares: [authImpl, loggerImpl] },
			);

			const ctx = createMockCtx();
			const handler = getHandler(module.handlers.test);
			await handler(ctx, {});

			expect(executionOrder).toEqual(["auth", "logger", "log:handler"]);
		});

		it("supports mixed static layer and per-request middleware", async () => {
			const { middleware } = await import("./server");

			class StaticService extends Context.Tag("StaticService")<
				StaticService,
				{ value: string }
			>() {}

			class StaticMiddleware extends RpcMiddleware.Tag<StaticMiddleware>()(
				"StaticMiddleware",
				{ provides: StaticService },
			) {}

			const factory = createRpcFactory({ schema: testSchema });
			let perRequestCallCount = 0;

			const authImpl = middleware(AuthMiddleware, () => {
				perRequestCallCount++;
				return Effect.succeed({ id: `user-${perRequestCallCount}`, name: `User ${perRequestCallCount}` });
			});

			const staticLayer = Layer.succeed(StaticService, { value: "static-value" });

			const test = factory.query({ success: Schema.String });
			test.implement(() =>
				Effect.gen(function* () {
					const user = yield* CurrentUser;
					const static_ = yield* StaticService;
					return `${user.name}: ${static_.value}`;
				}),
			);

			const module = makeRpcModule(
				{
					test: test
						.middleware(AuthMiddleware)
						.middleware(StaticMiddleware),
				},
				{
					middlewares: {
						implementations: [authImpl],
						layer: staticLayer,
					},
				},
			);

			const ctx = createMockCtx();
			const handler = getHandler(module.handlers.test);

			const result1 = await handler(ctx, {});
			const success1 = assertSuccess(result1);
			expect(success1.value).toBe("User 1: static-value");

			const result2 = await handler(ctx, {});
			const success2 = assertSuccess(result2);
			expect(success2.value).toBe("User 2: static-value");

			expect(perRequestCallCount).toBe(2);
		});
	});
});
