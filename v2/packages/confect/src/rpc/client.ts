import type { Rpc } from "@effect/rpc";
import type {
	FunctionReference,
	RegisteredQuery,
	RegisteredMutation,
	RegisteredAction,
} from "convex/server";
import { Atom, Result } from "@effect-atom/atom";
import { Result as ResultModule, useAtomValue } from "@effect-atom/atom-react";
import * as Cause from "effect/Cause";
import { Cache, Chunk, Data, Duration, Effect, Exit, FiberId, Layer, Option, Stream } from "effect";

import {
	ConvexClient,
	ConvexClientLayer,
	ConvexHttpClientLayer,
	type ConvexRequestMetadata,
} from "../client";
import type { AnyRpcModule, ExitEncoded, RpcEndpoint } from "./server";
import {
	makeRpcTransportHeaders,
	type RpcClientKind,
	withOptionalRpcTelemetryContext,
} from "./telemetry";

export class RpcDefectError extends Data.TaggedError("RpcDefectError")<{
	readonly defect: unknown;
}> {
	get message(): string {
		return `RpcDefectError: ${extractDefectMessage(this.defect)}`;
	}
}

/** Best-effort extraction of a human-readable message from an opaque defect. */
const extractDefectMessage = (defect: unknown): string => {
	if (defect === null || defect === undefined) return "Unknown defect";
	if (typeof defect === "string") return defect;
	if (defect instanceof Error) return defect.message;
	if (typeof defect === "object") {
		const obj = defect as Record<string, unknown>;
		// TaggedError / Data.TaggedError
		if (typeof obj._tag === "string" && typeof obj.message === "string") {
			return `[${obj._tag}] ${obj.message}`;
		}
		if (typeof obj._tag === "string") return obj._tag;
		if (typeof obj.message === "string") return obj.message;
		try {
			return JSON.stringify(defect);
		} catch {
			return String(defect);
		}
	}
	return String(defect);
};

type EndpointPayload<E> = E extends RpcEndpoint<infer _Tag, infer R, infer _ConvexFn>
	? Rpc.Payload<R>
	: never;

type EndpointSuccess<E> = E extends RpcEndpoint<infer _Tag, infer R, infer _ConvexFn>
	? Rpc.Success<R>
	: never;

type EndpointError<E> = E extends RpcEndpoint<infer _Tag, infer R, infer _ConvexFn>
	? Rpc.Error<R>
	: never;

type EndpointKind<E> = E extends RpcEndpoint<infer _Tag, infer _R, infer ConvexFn>
	? ConvexFn extends RegisteredQuery<infer _V, infer _A, infer _R>
		? "query"
		: ConvexFn extends RegisteredMutation<infer _V, infer _A, infer _R>
			? "mutation"
			: ConvexFn extends RegisteredAction<infer _V, infer _A, infer _R>
				? "action"
				: never
	: never;

type IsPaginatedResult<T> = T extends {
	page: ReadonlyArray<infer _Item>;
	isDone: boolean;
	continueCursor: string;
}
	? true
	: false;

type ExtractPageItem<T> = T extends {
	page: ReadonlyArray<infer Item>;
	isDone: boolean;
	continueCursor: string;
}
	? Item
	: never;

type IsPaginatedPayload<T> = T extends {
	cursor: string | null;
	numItems: number;
}
	? true
	: false;

/**
 * Extra payload fields for a paginated endpoint – everything except the
 * pagination primitives (`cursor` and `numItems`) that the framework manages.
 */
type PaginatedExtraPayload<Payload> = Omit<Payload, "cursor" | "numItems">;

type PaginatedArgs<Extra> = keyof Extra extends never
	? [numItems: number]
	: [numItems: number, payload: Extra];

export interface RpcReadOptions {
	readonly enabled?: boolean;
}

export type RpcQueryClient<Payload, Success, Error> = {
	query: (
		payload: Payload,
		options?: RpcReadOptions,
	) => Atom.Atom<Result.Result<Success, Error | RpcDefectError>>;
	queryEffect: (payload: Payload) => Effect.Effect<Success, Error | RpcDefectError>;
	queryPromise: (payload: Payload) => Promise<Success>;
	subscription: (
		payload: Payload,
		options?: RpcReadOptions,
	) => Atom.Atom<Result.Result<Success, Error | RpcDefectError>>;
} & (IsPaginatedResult<Success> extends true
	? IsPaginatedPayload<Payload> extends true
		? {
				paginated: (
					...args: PaginatedArgs<PaginatedExtraPayload<Payload>>
				) => Atom.Writable<
					Atom.PullResult<ExtractPageItem<Success>, Error | RpcDefectError>,
					void
				>;
			}
		: {}
	: {});

export type RpcMutationClient<Payload, Success, Error> = {
	mutate: Atom.AtomResultFn<Payload, Success, Error | RpcDefectError>;
	mutateEffect: (payload: Payload) => Effect.Effect<Success, Error | RpcDefectError>;
	mutatePromise: (payload: Payload) => Promise<Success>;
};

export type RpcActionClient<Payload, Success, Error> = {
	call: Atom.AtomResultFn<Payload, Success, Error | RpcDefectError>;
	callEffect: (payload: Payload) => Effect.Effect<Success, Error | RpcDefectError>;
	callPromise: (payload: Payload) => Promise<Success>;
	callAsQuery: (
		payload: Payload,
	) => Atom.Atom<Result.Result<Success, Error | RpcDefectError>>;
};

type DecorateEndpoint<E, Shared extends Record<string, unknown> = {}> =
	EndpointKind<E> extends "query"
		? RpcQueryClient<
				Omit<EndpointPayload<E>, keyof Shared>,
				EndpointSuccess<E>,
				EndpointError<E>
			>
		: EndpointKind<E> extends "mutation"
			? RpcMutationClient<
					Omit<EndpointPayload<E>, keyof Shared>,
					EndpointSuccess<E>,
					EndpointError<E>
				>
			: EndpointKind<E> extends "action"
				? RpcActionClient<
						Omit<EndpointPayload<E>, keyof Shared>,
						EndpointSuccess<E>,
						EndpointError<E>
					>
				: never;

type EndpointsRecord = Record<string, RpcEndpoint<string, Rpc.Any, unknown>>;

export type RpcModuleClientMethods<TEndpoints extends EndpointsRecord, Shared extends Record<string, unknown> = {}> = {
	readonly [K in keyof TEndpoints]: DecorateEndpoint<TEndpoints[K], Shared>;
};

export interface RpcModuleClientConfig {
	readonly url: string;
	readonly layer?: Layer.Layer<ConvexClient>;
	readonly enablePayloadTelemetryFallback?: boolean;
}

type ConvexApiModule = Record<string, FunctionReference<"query" | "mutation" | "action">>;

type DecorateModuleEndpoints<TModule extends AnyRpcModule, Shared extends Record<string, unknown>> = {
	[K in keyof TModule]: TModule[K] extends RpcEndpoint<string, Rpc.Any, unknown>
		? DecorateEndpoint<TModule[K], Shared>
		: never;
};

type ExtractDecoratedEndpoints<TModule extends AnyRpcModule, Shared extends Record<string, unknown>> = 
	Pick<DecorateModuleEndpoints<TModule, Shared>, {
		[K in keyof TModule]: TModule[K] extends RpcEndpoint<string, Rpc.Any, unknown> ? K : never;
	}[keyof TModule]>;

export type RpcModuleClient<
	TModule extends AnyRpcModule,
	Shared extends Record<string, unknown> = {},
> = {
	readonly runtime: Atom.AtomRuntime<ConvexClient>;
} & ExtractDecoratedEndpoints<TModule, Shared>;

type CauseEncoded<E = unknown, D = unknown> =
	| { readonly _tag: "Empty" }
	| { readonly _tag: "Fail"; readonly error: E }
	| { readonly _tag: "Die"; readonly defect: D }
	| { readonly _tag: "Interrupt"; readonly fiberId: unknown }
	| { readonly _tag: "Sequential"; readonly left: CauseEncoded<E, D>; readonly right: CauseEncoded<E, D> }
	| { readonly _tag: "Parallel"; readonly left: CauseEncoded<E, D>; readonly right: CauseEncoded<E, D> };

const decodeCause = (encoded: CauseEncoded): Cause.Cause<unknown> => {
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
			return Cause.sequential(decodeCause(encoded.left), decodeCause(encoded.right));
		case "Parallel":
			return Cause.parallel(decodeCause(encoded.left), decodeCause(encoded.right));
	}
};

const decodeExit = (encoded: ExitEncoded): Exit.Exit<unknown, unknown> => {
	// Safety: if the response isn't a valid ExitEncoded, wrap as defect
	if (
		!encoded ||
		typeof encoded !== "object" ||
		!("_tag" in encoded)
	) {
		return Exit.fail(
			new RpcDefectError({ defect: `Unexpected RPC response: ${JSON.stringify(encoded)}` }),
		);
	}
	if (encoded._tag === "Success") {
		return Exit.succeed(encoded.value);
	}
	if (encoded._tag !== "Failure" || !encoded.cause) {
		return Exit.fail(
			new RpcDefectError({ defect: `Unexpected exit tag: ${String(encoded._tag)}` }),
		);
	}
	const cause = decodeCause(encoded.cause);
	const failureOption = Cause.failureOption(cause);
	if (Option.isSome(failureOption)) {
		return Exit.fail(failureOption.value);
	}
	const defects = Cause.defects(cause);
	if (Chunk.isNonEmpty(defects)) {
		return Exit.fail(new RpcDefectError({ defect: Chunk.unsafeHead(defects) }));
	}
	if (Cause.isInterrupted(cause)) {
		return Exit.fail(new RpcDefectError({ defect: "Interrupted" }));
	}
	return Exit.fail(new RpcDefectError({ defect: "Empty cause" }));
};

const ensureNextRequestDataAccess = async () => {
	if (typeof window !== "undefined") {
		return;
	}

	// `next/headers` exists only in Next.js server runtime. Attempt import and
	// request binding opportunistically; skip in tests and non-Next environments.
	try {
		const { headers } = await import("next/headers");
		await headers();
	} catch {
		return;
	}
};

const withRpcClientSpan = <A>(
	kind: RpcClientKind,
	endpointTag: string,
	payload: unknown,
	enablePayloadTelemetryFallback: boolean,
	run: (
		payloadWithTelemetry: unknown,
		requestMetadata: ConvexRequestMetadata,
	) => Effect.Effect<A, unknown, ConvexClient>,
): Effect.Effect<A, unknown, ConvexClient> =>
	Effect.useSpan(
		`rpc.client.${kind}.${endpointTag}`,
		{
			kind: "client",
			captureStackTrace: false,
			attributes: {
				"rpc.system": "convex",
				"rpc.method": endpointTag,
				"rpc.confect.kind": kind,
			},
		},
		(span) => {
			const requestMetadata: ConvexRequestMetadata = {
				headers: makeRpcTransportHeaders(span),
			};
			return run(
				withOptionalRpcTelemetryContext(
					kind,
					payload,
					span,
					enablePayloadTelemetryFallback,
				),
				requestMetadata,
			);
		},
	);

const createQueryEffect = (
	endpointTag: string,
	convexFn: FunctionReference<"query">,
	payload: unknown,
	enablePayloadTelemetryFallback: boolean,
): Effect.Effect<unknown, unknown, ConvexClient> =>
	withRpcClientSpan(
		"query",
		endpointTag,
		payload,
		enablePayloadTelemetryFallback,
		(payloadWithTelemetry, requestMetadata) =>
		Effect.gen(function* () {
			const client = yield* ConvexClient;
			const encodedExit = yield* client.query(
				convexFn,
				payloadWithTelemetry,
				requestMetadata,
			);
			const exit = decodeExit(encodedExit as ExitEncoded);
			if (Exit.isSuccess(exit)) {
				return exit.value;
			}
			return yield* exit;
		}),
	);

const createMutationEffect = (
	endpointTag: string,
	convexFn: FunctionReference<"mutation">,
	payload: unknown,
	enablePayloadTelemetryFallback: boolean,
): Effect.Effect<unknown, unknown, ConvexClient> =>
	withRpcClientSpan(
		"mutation",
		endpointTag,
		payload,
		enablePayloadTelemetryFallback,
		(payloadWithTelemetry, requestMetadata) =>
		Effect.gen(function* () {
			const client = yield* ConvexClient;
			const encodedExit = yield* client.mutation(
				convexFn,
				payloadWithTelemetry,
				requestMetadata,
			);
			const exit = decodeExit(encodedExit as ExitEncoded);
			if (Exit.isSuccess(exit)) {
				return exit.value;
			}
			return yield* exit;
		}),
	);

const createActionEffect = (
	endpointTag: string,
	convexFn: FunctionReference<"action">,
	payload: unknown,
	enablePayloadTelemetryFallback: boolean,
): Effect.Effect<unknown, unknown, ConvexClient> =>
	withRpcClientSpan(
		"action",
		endpointTag,
		payload,
		enablePayloadTelemetryFallback,
		(payloadWithTelemetry, requestMetadata) =>
		Effect.gen(function* () {
			const client = yield* ConvexClient;
			const encodedExit = yield* client.action(
				convexFn,
				payloadWithTelemetry,
				requestMetadata,
			);
			const exit = decodeExit(encodedExit as ExitEncoded);
			if (Exit.isSuccess(exit)) {
				return exit.value;
			}
			return yield* exit;
		}),
	);

const createQueryAtom = (
	runtime: Atom.AtomRuntime<ConvexClient>,
	endpointTag: string,
	convexFn: FunctionReference<"query">,
	payload: unknown,
	enablePayloadTelemetryFallback: boolean,
): Atom.Atom<Result.Result<unknown, unknown>> => {
	return runtime.atom(
		createQueryEffect(
			endpointTag,
			convexFn,
			payload,
			enablePayloadTelemetryFallback,
		),
	);
};

const createSubscriptionAtom = (
	runtime: Atom.AtomRuntime<ConvexClient>,
	endpointTag: string,
	convexFn: FunctionReference<"query">,
	payload: unknown,
	enablePayloadTelemetryFallback: boolean,
): Atom.Atom<Result.Result<unknown, unknown>> => {
	return runtime.atom(
		Stream.unwrap(
			withRpcClientSpan(
				"query",
				endpointTag,
				payload,
				enablePayloadTelemetryFallback,
				(payloadWithTelemetry, _requestMetadata) =>
					Effect.gen(function* () {
						const client = yield* ConvexClient;
						return client.subscribe(convexFn, payloadWithTelemetry).pipe(
							Stream.mapEffect((encodedExit) => {
								const exit = decodeExit(encodedExit as ExitEncoded);
								if (Exit.isSuccess(exit)) {
									return Effect.succeed(exit.value);
								}
								return exit;
							}),
						);
					}),
			),
		),
	);
};

const createActionQueryAtom = (
	runtime: Atom.AtomRuntime<ConvexClient>,
	endpointTag: string,
	convexFn: FunctionReference<"action">,
	payload: unknown,
	enablePayloadTelemetryFallback: boolean,
): Atom.Atom<Result.Result<unknown, unknown>> => {
	return runtime.atom(
		createActionEffect(
			endpointTag,
			convexFn,
			payload,
			enablePayloadTelemetryFallback,
		),
	);
};

const createMutationFn = (
	runtime: Atom.AtomRuntime<ConvexClient>,
	endpointTag: string,
	convexFn: FunctionReference<"mutation">,
	getShared: () => Record<string, unknown>,
	enablePayloadTelemetryFallback: boolean,
): Atom.AtomResultFn<unknown, unknown, unknown> => {
	return runtime.fn<unknown>()(
		Effect.fnUntraced(function* (payload) {
			const fullPayload = { ...getShared(), ...(payload as object) };
			return yield* createMutationEffect(
				endpointTag,
				convexFn,
				fullPayload,
				enablePayloadTelemetryFallback,
			);
		}),
	);
};

const createActionFn = (
	runtime: Atom.AtomRuntime<ConvexClient>,
	endpointTag: string,
	convexFn: FunctionReference<"action">,
	getShared: () => Record<string, unknown>,
	enablePayloadTelemetryFallback: boolean,
): Atom.AtomResultFn<unknown, unknown, unknown> => {
	return runtime.fn<unknown>()(
		Effect.fnUntraced(function* (payload) {
			const fullPayload = { ...getShared(), ...(payload as object) };
			return yield* createActionEffect(
				endpointTag,
				convexFn,
				fullPayload,
				enablePayloadTelemetryFallback,
			);
		}),
	);
};

interface PaginatedResult<T> {
	page: ReadonlyArray<T>;
	isDone: boolean;
	continueCursor: string;
}

const createPaginatedAtom = (
	runtime: Atom.AtomRuntime<ConvexClient>,
	endpointTag: string,
	convexFn: FunctionReference<"query">,
	getShared: () => Record<string, unknown>,
	numItems: number,
	extraPayload: Record<string, unknown>,
	enablePayloadTelemetryFallback: boolean,
): Atom.Writable<Atom.PullResult<unknown, unknown>, void> => {
	return runtime.pull(
		Stream.paginateChunkEffect(null as string | null, (cursor) =>
			Effect.gen(function* () {
				const fullPayload = {
					...getShared(),
					...extraPayload,
					cursor,
					numItems,
				};
				const result = (yield* createQueryEffect(
					endpointTag,
					convexFn,
					fullPayload,
					enablePayloadTelemetryFallback,
				)) as PaginatedResult<unknown>;
				const nextCursor = result.isDone
					? Option.none<string | null>()
					: Option.some(result.continueCursor);

				return [Chunk.fromIterable(result.page), nextCursor] as const;
			}),
		),
	);
};

const noop = () => {};

const isRpcReadEnabled = (options?: RpcReadOptions): boolean =>
	options?.enabled ?? true;

const makeDisabledResultAtom = <Success, Error>() =>
	Atom.make(Result.initial<Success, Error>());

export function createRpcClient<
	TModule extends AnyRpcModule,
	Shared extends Record<string, unknown> = {},
>(
	convexApi: ConvexApiModule,
	config: RpcModuleClientConfig,
	getShared: () => Shared = () => ({}) as Shared,
): RpcModuleClient<TModule, Shared> {
	const baseLayer = config.layer ?? ConvexClientLayer(config.url);
	const enablePayloadTelemetryFallback =
		config.enablePayloadTelemetryFallback ?? true;
	const runtime = Atom.runtime(baseLayer);

	const queryFamilies = new Map<string, (payload: unknown) => Atom.Atom<Result.Result<unknown, unknown>>>();
	const subscriptionFamilies = new Map<string, (payload: unknown) => Atom.Atom<Result.Result<unknown, unknown>>>();
	const actionQueryFamilies = new Map<string, (payload: unknown) => Atom.Atom<Result.Result<unknown, unknown>>>();
	const mutationFns = new Map<string, Atom.AtomResultFn<unknown, unknown, unknown>>();
	const actionFns = new Map<string, Atom.AtomResultFn<unknown, unknown, unknown>>();
	const paginatedFamilies = new Map<string, (numItems: number, extra: Record<string, unknown>) => Atom.Writable<Atom.PullResult<unknown, unknown>, void>>();

	const getQueryFamily = (tag: string) => {
		let family = queryFamilies.get(tag);
		if (!family) {
			const convexFn = convexApi[tag] as FunctionReference<"query">;
			family = Atom.family((p: unknown) => {
				const fullPayload = { ...getShared(), ...(p as object) };
				return createQueryAtom(
					runtime,
					tag,
					convexFn,
					fullPayload,
					enablePayloadTelemetryFallback,
				);
			});
			queryFamilies.set(tag, family);
		}
		return family;
	};

	const getSubscriptionFamily = (tag: string) => {
		let family = subscriptionFamilies.get(tag);
		if (!family) {
			const convexFn = convexApi[tag] as FunctionReference<"query">;
			family = Atom.family((p: unknown) => {
				const fullPayload = { ...getShared(), ...(p as object) };
				return createSubscriptionAtom(
					runtime,
					tag,
					convexFn,
					fullPayload,
					enablePayloadTelemetryFallback,
				);
			});
			subscriptionFamilies.set(tag, family);
		}
		return family;
	};

	const getMutationFn = (tag: string) => {
		let fn = mutationFns.get(tag);
		if (!fn) {
			const convexFn = convexApi[tag] as FunctionReference<"mutation">;
			fn = createMutationFn(
				runtime,
				tag,
				convexFn,
				getShared,
				enablePayloadTelemetryFallback,
			);
			mutationFns.set(tag, fn);
		}
		return fn;
	};

	const getActionFn = (tag: string) => {
		let fn = actionFns.get(tag);
		if (!fn) {
			const convexFn = convexApi[tag] as FunctionReference<"action">;
			fn = createActionFn(
				runtime,
				tag,
				convexFn,
				getShared,
				enablePayloadTelemetryFallback,
			);
			actionFns.set(tag, fn);
		}
		return fn;
	};

	const getActionQueryFamily = (tag: string) => {
		let family = actionQueryFamilies.get(tag);
		if (!family) {
			const convexFn = convexApi[tag] as FunctionReference<"action">;
			family = Atom.family((p: unknown) => {
				const fullPayload = { ...getShared(), ...(p as object) };
				return createActionQueryAtom(
					runtime,
					tag,
					convexFn,
					fullPayload,
					enablePayloadTelemetryFallback,
				);
			});
			actionQueryFamilies.set(tag, family);
		}
		return family;
	};

	const getPaginatedFamily = (tag: string) => {
		let cached = paginatedFamilies.get(tag);
		if (!cached) {
			const convexFn = convexApi[tag] as FunctionReference<"query">;
			// Atom.family takes a single arg; use a stable JSON key so that
			// identical (numItems + extra) combinations share the same atom.
			const atomFamily = Atom.family((key: string) => {
				const { numItems, extra } = JSON.parse(key) as {
					numItems: number;
					extra: Record<string, unknown>;
				};
				return createPaginatedAtom(
					runtime,
					tag,
					convexFn,
					getShared,
					numItems,
					extra,
					enablePayloadTelemetryFallback,
				);
			});
			cached = (numItems: number, extra: Record<string, unknown>) =>
				atomFamily(JSON.stringify({ numItems, extra }));
			paginatedFamilies.set(tag, cached);
		}
		return cached;
	};

	const endpointProxyCache = new Map<string, unknown>();

	const proxy = new Proxy(noop, {
		get(_target, prop) {
			if (prop === "runtime") {
				return runtime;
			}
			if (prop === "then") {
				return undefined;
			}
			if (typeof prop !== "string") {
				return undefined;
			}

			let endpointProxy = endpointProxyCache.get(prop);
			if (!endpointProxy) {
				const disabledResultAtom = makeDisabledResultAtom<
					never,
					RpcDefectError
				>();

				const queryEffect = (payload: unknown) => {
					const convexFn = convexApi[prop] as FunctionReference<"query">;
					const fullPayload = { ...getShared(), ...(payload as object) };
					return createQueryEffect(
						prop,
						convexFn,
						fullPayload,
						enablePayloadTelemetryFallback,
					).pipe(
						Effect.provide(baseLayer),
					);
				};

				const mutateEffect = (payload: unknown) => {
					const convexFn = convexApi[prop] as FunctionReference<"mutation">;
					const fullPayload = { ...getShared(), ...(payload as object) };
					return createMutationEffect(
						prop,
						convexFn,
						fullPayload,
						enablePayloadTelemetryFallback,
					).pipe(
						Effect.provide(baseLayer),
					);
				};

				const callEffect = (payload: unknown) => {
					const convexFn = convexApi[prop] as FunctionReference<"action">;
					const fullPayload = { ...getShared(), ...(payload as object) };
					return createActionEffect(
						prop,
						convexFn,
						fullPayload,
						enablePayloadTelemetryFallback,
					).pipe(
						Effect.provide(baseLayer),
					);
				};

				endpointProxy = {
					query: (payload: unknown, options?: RpcReadOptions) =>
						isRpcReadEnabled(options)
							? getQueryFamily(prop)(payload)
							: disabledResultAtom,
					queryEffect,
					queryPromise: (payload: unknown) => Effect.runPromise(queryEffect(payload)),
					subscription: (payload: unknown, options?: RpcReadOptions) =>
						isRpcReadEnabled(options)
							? getSubscriptionFamily(prop)(payload)
							: disabledResultAtom,
					mutate: getMutationFn(prop),
					mutateEffect,
					mutatePromise: (payload: unknown) => Effect.runPromise(mutateEffect(payload)),
					call: getActionFn(prop),
					callAsQuery: (payload: unknown) => getActionQueryFamily(prop)(payload),
					callEffect,
					callPromise: (payload: unknown) => Effect.runPromise(callEffect(payload)),
					paginated: (numItems: number, extra: Record<string, unknown> = {}) => getPaginatedFamily(prop)(numItems, extra),
				};
				endpointProxyCache.set(prop, endpointProxy);
			}
			return endpointProxy;
		},
	});

	return proxy as unknown as RpcModuleClient<TModule, Shared>;
}

// ---------------------------------------------------------------------------
// Server-side RPC query client (HTTP-only, no WebSocket, no atoms)
// ---------------------------------------------------------------------------

type ServerQueryEndpoint<Payload, Success> = {
	readonly queryPromise: (payload: Payload) => Promise<Success>;
};

type ServerDecorateEndpoint<E, Shared extends Record<string, unknown> = {}> =
	EndpointKind<E> extends "query"
		? ServerQueryEndpoint<
				Omit<EndpointPayload<E>, keyof Shared>,
				EndpointSuccess<E>
			>
		: never;

export type ServerRpcModuleClient<
	TModule extends AnyRpcModule,
	Shared extends Record<string, unknown> = {},
> = {
	readonly [K in keyof TModule as TModule[K] extends RpcEndpoint<string, Rpc.Any, unknown>
		? EndpointKind<TModule[K]> extends "query"
			? K
			: never
		: never]: ServerDecorateEndpoint<TModule[K], Shared>;
};

export interface ServerRpcClientConfig {
	readonly url: string;
	/**
	 * Optional layer override (e.g. for testing). When provided, this layer is
	 * used instead of creating a `ConvexHttpClientLayer` from `url`.
	 */
	readonly layer?: Layer.Layer<ConvexClient>;
	/**
	 * Optional auth token resolver for server-side requests.
	 *
	 * When provided, each `queryPromise` call resolves the current auth token
	 * and uses a token-authenticated HTTP client. Cache keys are also scoped by
	 * auth identity to avoid cross-user cache mixing.
	 */
	readonly getAuthToken?: () => Promise<string | null | undefined>;
}

/**
 * Create a server-side RPC client that only supports query promises.
 * Uses `ConvexHttpClientLayer` (HTTP only, no WebSocket).
 * Intended for use in Next.js server components and route handlers.
 *
 * Only query endpoints are exposed (mutations/actions are excluded).
 * Each endpoint has a single method: `queryPromise(payload) => Promise<Success>`.
 */
/**
 * Default TTL for the server-side query deduplication cache.
 *
 * During SSR multiple server components may call `queryPromise` with the
 * same endpoint + payload concurrently.  `Cache` automatically coalesces
 * concurrent lookups for the same key into a single in-flight request.
 * Completed results are kept for this duration so that near-simultaneous
 * calls (within the same render pass) hit the cache rather than firing
 * duplicate HTTP requests.  The TTL is intentionally short to avoid
 * serving stale data across unrelated requests on a long-lived server.
 */
const SERVER_QUERY_CACHE_TTL = Duration.seconds(5);

/**
 * Maximum number of distinct (endpoint + payload) entries kept in the
 * server-side query cache.  This is deliberately generous — each entry
 * is small (just the resolved value) and expires quickly.
 */
const SERVER_QUERY_CACHE_CAPACITY = 256;

export function createServerRpcQuery<
	TModule extends AnyRpcModule,
	Shared extends Record<string, unknown> = {},
>(
	convexApi: ConvexApiModule,
	config: ServerRpcClientConfig,
	getShared: () => Shared = () => ({}) as Shared,
): ServerRpcModuleClient<TModule, Shared> {
	const defaultLayer = config.layer ?? ConvexHttpClientLayer(config.url);

	const authScopeByToken = new Map<string, string>();
	const authLayerByScope = new Map<string, Layer.Layer<ConvexClient>>();
	let nextAuthScopeId = 0;

	const AUTH_SCOPE_CACHE_LIMIT = 256;

	const resolveAuthToken = async (): Promise<string | null> => {
		if (config.getAuthToken === undefined) {
			return null;
		}

		const token = await config.getAuthToken();
		if (token === null || token === undefined || token.length === 0) {
			return null;
		}

		const trimmed = token.trim();
		if (trimmed.length === 0) {
			return null;
		}

		if (trimmed.startsWith("Bearer ")) {
			const bearerValue = trimmed.slice("Bearer ".length).trim();
			return bearerValue.length === 0 ? null : bearerValue;
		}

		return trimmed;
	};

	const resetAuthScopeCaches = () => {
		authScopeByToken.clear();
		authLayerByScope.clear();
	};

	const getAuthScope = (token: string | null): string => {
		if (token === null) {
			return "anon";
		}

		const existingScope = authScopeByToken.get(token);
		if (existingScope !== undefined) {
			return existingScope;
		}

		nextAuthScopeId += 1;
		const scope = `auth-${nextAuthScopeId}`;
		authScopeByToken.set(token, scope);

		if (authScopeByToken.size > AUTH_SCOPE_CACHE_LIMIT) {
			resetAuthScopeCaches();
			authScopeByToken.set(token, scope);
		}

		return scope;
	};

	const getLayerForScope = (
		authScope: string,
		authToken: string | null,
	): Layer.Layer<ConvexClient> => {
		if (config.layer !== undefined) {
			return config.layer;
		}

		const cachedLayer = authLayerByScope.get(authScope);
		if (cachedLayer !== undefined) {
			return cachedLayer;
		}

		if (authToken === null) {
			authLayerByScope.set(authScope, defaultLayer);
			return defaultLayer;
		}

		const nextLayer = ConvexHttpClientLayer(config.url, { authToken });
		authLayerByScope.set(authScope, nextLayer);
		return nextLayer;
	};

	/**
	 * A single `Cache<string, unknown, unknown>` keyed by
	 * `json({ authScope, endpointName, payload })`.
	 *
	 * `Cache.make` returns an `Effect` — we run it once eagerly via
	 * `Effect.runSync` wrapped in a lazy singleton so it's created on first
	 * access.  The lookup function is provided the layer so each cache miss
	 * fires exactly one HTTP request through the `ConvexHttpClientLayer`.
	 *
	 * Because Effect's `Cache` coalesces concurrent lookups for the same key,
	 * three concurrent calls to `queryPromise({ id: "x" })` result in a
	 * single Convex HTTP call.
	 */

	// We store a Map of endpoint name → convex function ref so the lookup
	// can resolve which function to call from just the cache key string.
	const convexFnRegistry = new Map<string, FunctionReference<"query">>();

	const cacheEffect = Cache.make({
		capacity: SERVER_QUERY_CACHE_CAPACITY,
		timeToLive: SERVER_QUERY_CACHE_TTL,
		lookup: (cacheKey: string) => {
			const decodedKey = JSON.parse(cacheKey);
			if (decodedKey === null || typeof decodedKey !== "object") {
				return Effect.die(new Error("Invalid server RPC cache key"));
			}
			if (!("endpointName" in decodedKey) || !("payload" in decodedKey)) {
				return Effect.die(new Error("Missing server RPC cache key fields"));
			}
			if (typeof decodedKey.endpointName !== "string") {
				return Effect.die(new Error("Invalid server RPC endpoint cache key"));
			}
			if (!("authScope" in decodedKey) || typeof decodedKey.authScope !== "string") {
				return Effect.die(new Error("Invalid server RPC auth scope cache key"));
			}

			const endpointName = decodedKey.endpointName;
			const authScope = decodedKey.authScope;
			const fullPayload = decodedKey.payload;
			const convexFn = convexFnRegistry.get(endpointName);
			if (!convexFn) {
				return Effect.die(
					new Error(`No registered Convex function for endpoint "${endpointName}"`),
				);
			}

			const requestLayer = authLayerByScope.get(authScope) ?? defaultLayer;
			return Effect.provide(
				createQueryEffect(endpointName, convexFn, fullPayload, false),
				requestLayer,
			);
		},
	});

	const makeQueryCache = () =>
		Effect.runSync(Effect.provide(cacheEffect, defaultLayer));

	let queryCache = Option.none<ReturnType<typeof makeQueryCache>>();

	const getOrCreateQueryCache = () => {
		if (Option.isSome(queryCache)) {
			return queryCache.value;
		}

		const nextQueryCache = makeQueryCache();
		queryCache = Option.some(nextQueryCache);
		return nextQueryCache;
	};

	const endpointCache = new Map<string, ServerQueryEndpoint<unknown, unknown>>();

	const getEndpoint = (prop: string): ServerQueryEndpoint<unknown, unknown> => {
		let endpoint = endpointCache.get(prop);
		if (!endpoint) {
			const convexFn = convexApi[prop];
			if (!convexFn) {
				throw new Error(`No Convex function found for endpoint "${prop}"`);
			}
			convexFnRegistry.set(prop, convexFn as FunctionReference<"query">);

			endpoint = {
				queryPromise: async (payload: unknown) => {
					await ensureNextRequestDataAccess();
					const authToken = await resolveAuthToken();
					const authScope = getAuthScope(authToken);

					const payloadObject =
						payload !== null && typeof payload === "object" ? payload : {};
					const fullPayload = { ...getShared(), ...payloadObject };
					const cacheKey = JSON.stringify({
						authScope,
						endpointName: prop,
						payload: fullPayload,
					});
					getLayerForScope(authScope, authToken);

					return Effect.runPromise(
						Effect.gen(function* () {
							const queryCache = yield* Effect.sync(getOrCreateQueryCache);
							return yield* queryCache.get(cacheKey);
						}),
					);
				},
			};
			endpointCache.set(prop, endpoint);
		}
		return endpoint;
	};

	const proxy = new Proxy({} as Record<string, ServerQueryEndpoint<unknown, unknown>>, {
		get(_target, prop) {
			if (prop === "then") return undefined;
			if (typeof prop !== "string") return undefined;
			return getEndpoint(prop);
		},
	});

	return proxy as ServerRpcModuleClient<TModule, Shared>;
}

// ---------------------------------------------------------------------------
// React hook: merge server-fetched data with real-time subscription
// ---------------------------------------------------------------------------

/**
 * Merge server-fetched initial data with a real-time Confect RPC subscription.
 *
 * Use this in client components that receive server data via `use(promise)`
 * (React Suspense) and also subscribe for live updates. The hook returns the
 * latest subscription value when available, falling back to `initialData`.
 *
 * No `useEffect`, no `useState` — pure derivation in the render path.
 *
 * The subscription atom from `client.X.subscription(...)` is typed as
 * `Atom<Result<unknown, unknown>>` because the RPC proxy loses generic info.
 * The type of `initialData` anchors the return type: both the server query
 * and the subscription call the same RPC endpoint, so the shapes match at
 * runtime.
 *
 * @example
 * ```tsx
 * const initialData = use(serverPromise); // suspends
 * const prAtom = useMemo(() => client.getPr.subscription({ ... }), [...]);
 * const pr = useSubscriptionWithInitial(prAtom, initialData);
 * ```
 */
export function useSubscriptionWithInitial<T>(
	subscriptionAtom: Atom.Atom<Result.Result<unknown, unknown>>,
	initialData: T,
): T {
	const result = useAtomValue(subscriptionAtom);

	if (ResultModule.isInitial(result)) {
		return initialData;
	}

	const valueOption = ResultModule.value(result);
	if (Option.isSome(valueOption)) {
		// Safe: the subscription and server query call the same RPC endpoint,
		// so the runtime value matches T. The proxy erases the generic, but
		// the hook restores type safety at its boundary.
		return valueOption.value as T;
	}

	return initialData;
}
