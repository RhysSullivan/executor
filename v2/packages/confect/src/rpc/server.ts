import { Rpc, RpcGroup, RpcMiddleware } from "@effect/rpc";
import type {
	DefaultFunctionArgs,
	RegisteredMutation,
	RegisteredQuery,
	RegisteredAction,
	GenericQueryCtx,
	GenericMutationCtx,
	GenericActionCtx,
	GenericDataModel,
} from "convex/server";
import {
	queryGeneric,
	mutationGeneric,
	actionGeneric,
	internalQueryGeneric,
	internalMutationGeneric,
	internalActionGeneric,
} from "convex/server";
import { v } from "convex/values";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
	ConfectActionCtx,
	ConfectMutationCtx,
	ConfectQueryCtx,
	makeQueryCtx,
	makeMutationCtx,
	makeActionCtx,
	type GenericConfectSchema,
	type TableNamesInSchema,
	type DocumentFromTable,
	type EncodedDocumentFromTable,
} from "../ctx";
import type { ConfectSchemaDefinition } from "../schema";
import { extractParentSpanFromPayload } from "./telemetry";

export { Rpc, RpcGroup, RpcMiddleware };

export {
	WrapperTypeId,
	type WrapperTypeId as WrapperTypeIdType,
	type Wrapper,
	isWrapper,
	wrap,
	fork,
	uninterruptible,
} from "@effect/rpc/Rpc";

export type Handler<Tag extends string> = Rpc.Handler<Tag>;
export type ToHandler<R extends Rpc.Any> = Rpc.ToHandler<R>;
export type HandlersFrom<R extends Rpc.Any> = RpcGroup.HandlersFrom<R>;
export type HandlersContext<R extends Rpc.Any, Handlers> = RpcGroup.HandlersContext<R, Handlers>;

type ConvexCtx = GenericQueryCtx<GenericDataModel> | GenericMutationCtx<GenericDataModel> | GenericActionCtx<GenericDataModel>;

export interface RpcInfo {
	readonly tag: string;
	readonly kind: "query" | "mutation" | "action" | "internalQuery" | "internalMutation" | "internalAction";
}

export interface MiddlewareOptions {
	readonly rpc: RpcInfo;
	readonly payload: unknown;
	readonly ctx: ConvexCtx;
}

export interface ConfectMiddlewareFn<Service, E = never> {
	(options: MiddlewareOptions): Effect.Effect<Service, E>;
}

export interface MiddlewareImplementation<M extends RpcMiddleware.TagClassAny = RpcMiddleware.TagClassAny> {
	readonly _tag: "MiddlewareImplementation";
	readonly middleware: M;
	readonly impl: ConfectMiddlewareFn<unknown, unknown>;
}

export const middleware = <M extends RpcMiddleware.TagClassAny>(
	middlewareTag: M,
	impl: M extends { readonly provides: Context.Tag<infer _Id, infer S> }
		? ConfectMiddlewareFn<S, M extends { readonly failure: Schema.Schema<infer E, infer _I, infer _R> } ? E : never>
		: ConfectMiddlewareFn<void, M extends { readonly failure: Schema.Schema<infer E, infer _I, infer _R> } ? E : never>,
): MiddlewareImplementation<M> => ({
	_tag: "MiddlewareImplementation",
	middleware: middlewareTag,
	impl: impl as ConfectMiddlewareFn<unknown, unknown>,
});

type TableSchemas<Tables extends GenericConfectSchema> = {
	[TableName in TableNamesInSchema<Tables>]: Schema.Schema<
		DocumentFromTable<Tables, TableName>,
		EncodedDocumentFromTable<Tables, TableName>
	>;
};

const extractTableSchemas = <Tables extends GenericConfectSchema>(
	tables: Tables,
): TableSchemas<Tables> => {
	const result: Record<string, Schema.Schema.AnyNoContext> = {};
	for (const [tableName, tableDef] of Object.entries(tables)) {
		result[tableName] = (tableDef as { documentSchema: Schema.Schema.AnyNoContext }).documentSchema;
	}
	return result as TableSchemas<Tables>;
};

export interface RpcEndpoint<
	Tag extends string,
	R extends Rpc.Any,
	ConvexFn,
> {
	readonly _tag: Tag;
	readonly rpc: R;
	readonly fn: ConvexFn;
}

// ---------------------------------------------------------------------------
// Handler ref — mutable slot filled by .implement()
// ---------------------------------------------------------------------------

type HandlerFn = (payload: never) => Effect.Effect<unknown, unknown, unknown>;

interface HandlerRef {
	current: HandlerFn | null;
	tag: string | null;
}

const createHandlerRef = (): HandlerRef => ({ current: null, tag: null });

// ---------------------------------------------------------------------------
// UnbuiltRpcEndpoint — definition only, no handler body
// ---------------------------------------------------------------------------

/**
 * An endpoint whose schema has been defined but whose handler may or may not
 * be wired yet. Call `.implement(handler)` to provide the implementation.
 *
 * The handler is stored in a mutable ref so that the definition file (which
 * `api.d.ts` imports) never needs to contain handler code. The implementation
 * can live in a separate file, breaking circular type dependencies.
 */
export interface UnbuiltRpcEndpoint<
	PayloadFields extends Schema.Struct.Fields,
	Success extends Schema.Schema.AnyNoContext,
	Error extends Schema.Schema.AnyNoContext | undefined,
	ConvexFnType,
	Middlewares extends ReadonlyArray<RpcMiddleware.TagClassAny> = [],
> {
	readonly __unbuilt: true;
	readonly kind: string;
	readonly payloadFields: PayloadFields;
	readonly successSchema: Success;
	readonly errorSchema: Error | undefined;
	readonly middlewares: Middlewares;
	readonly build: (tag: string, middlewareConfig: MiddlewareConfig | undefined) => RpcEndpoint<string, Rpc.Any, ConvexFnType>;
	middleware<M extends RpcMiddleware.TagClassAny>(
		middleware: M,
	): UnbuiltRpcEndpoint<PayloadFields, Success, Error, ConvexFnType, [...Middlewares, M]>;

	/**
	 * Wire the handler implementation for this endpoint.
	 *
	 * Can be called from a separate file to avoid circular type dependencies
	 * with Convex's generated `api.d.ts`.
	 */
	implement(
		handler: (
			payload: Schema.Struct.Type<PayloadFields>,
		) => Effect.Effect<
			Schema.Schema.Type<Success>,
			Error extends Schema.Schema.AnyNoContext ? Schema.Schema.Type<Error> : never,
			unknown
		>,
	): void;
}

export interface RpcFactoryConfig<
	ConfectSchema extends GenericConfectSchema,
	BasePayload extends Schema.Struct.Fields = {},
	BaseMiddlewares extends ReadonlyArray<RpcMiddleware.TagClassAny> = [],
> {
	readonly schema: ConfectSchemaDefinition<ConfectSchema>;
	readonly basePayload?: BasePayload;
	readonly baseMiddlewares?: BaseMiddlewares;
}

export type ExitEncoded<A = unknown, E = unknown, D = unknown> = Schema.ExitEncoded<A, E, D>;

type MiddlewareConfig = {
	readonly implementations: ReadonlyArray<MiddlewareImplementation>;
	readonly staticLayer?: Layer.Layer<unknown, unknown, never>;
};

const StaticLayerReady = Context.GenericTag<true>("@confect/StaticLayerReady");

const executeMiddlewares = (
	endpointMiddlewares: ReadonlyArray<RpcMiddleware.TagClassAny>,
	middlewareImpls: ReadonlyArray<MiddlewareImplementation>,
	options: MiddlewareOptions,
): Effect.Effect<Context.Context<never>, unknown, never> => {
	if (endpointMiddlewares.length === 0 || middlewareImpls.length === 0) {
		return Effect.succeed(Context.empty());
	}

	return Effect.gen(function* () {
		let ctx: Context.Context<never> = Context.empty();
		
		for (const endpointMiddleware of endpointMiddlewares) {
			const middlewareImpl = middlewareImpls.find(
				(candidate) => candidate.middleware === endpointMiddleware,
			);
			if (!middlewareImpl) {
				continue;
			}

			const result = yield* middlewareImpl.impl(options);
			const providesTag = middlewareImpl.middleware.provides;
			if (providesTag) {
				ctx = Context.add(ctx, providesTag, result) as Context.Context<never>;
			}
		}
		
		return ctx;
	});
};

type EndpointKind = "query" | "mutation" | "action" | "internalQuery" | "internalMutation" | "internalAction";

type ConvexRegistrar = (opts: { args: ReturnType<typeof v.any>; handler: (ctx: ConvexCtx, args: unknown) => Promise<ExitEncoded> }) => unknown;

interface EndpointConfig<Ctx, ConvexFnType> {
	readonly kind: EndpointKind;
	readonly ctxTag: Context.Tag<Ctx, Ctx>;
	readonly makeCtx: (rawCtx: ConvexCtx) => Ctx;
	readonly registrar: ConvexRegistrar;
	readonly _convexFnType?: ConvexFnType;
}

export const createRpcFactory = <
	ConfectSchema extends GenericConfectSchema,
	BasePayload extends Schema.Struct.Fields = {},
	BaseMiddlewares extends ReadonlyArray<RpcMiddleware.TagClassAny> = [],
>(
	config: RpcFactoryConfig<ConfectSchema, BasePayload, BaseMiddlewares>,
) => {
	const tableSchemas = extractTableSchemas(config.schema.tables);
	const basePayload = config.basePayload ?? ({} as BasePayload);
	const baseMiddlewares = config.baseMiddlewares ?? ([] as unknown as BaseMiddlewares);

	type MergedPayload<P extends Schema.Struct.Fields> = BasePayload & P;

	const makeConvexHandler = <
		PayloadFields extends Schema.Struct.Fields,
		Success extends Schema.Schema.AnyNoContext,
		Error extends Schema.Schema.AnyNoContext | undefined,
		Ctx,
	>(
		endpointConfig: EndpointConfig<Ctx, unknown>,
		tag: string,
		payloadFields: PayloadFields,
		successSchema: Success,
		errorSchema: Error,
		middlewareConfig: MiddlewareConfig | undefined,
		endpointMiddlewares: ReadonlyArray<RpcMiddleware.TagClassAny>,
		handlerRef: HandlerRef,
	) => {
		const payloadSchema = Schema.Struct(payloadFields) as unknown as Schema.Schema<Schema.Struct.Type<PayloadFields>, Schema.Struct.Encoded<PayloadFields>, never>;
		const decodePayload = Schema.decodeUnknownSync(payloadSchema);
		
		const exitSchemaVal = Schema.Exit({
			success: successSchema as Schema.Schema<unknown, unknown, never>,
			failure: (errorSchema ?? Schema.Never) as Schema.Schema<unknown, unknown, never>,
			defect: Schema.Defect,
		});
		const encodeExit = Schema.encodeSync(exitSchemaVal) as (exit: Exit.Exit<unknown, unknown>) => ExitEncoded;

		const rpcInfo: RpcInfo = { tag, kind: endpointConfig.kind };

		return async (rawCtx: ConvexCtx, args: unknown): Promise<ExitEncoded> => {
			if (!handlerRef.current) {
				throw new Error(
					`Handler not implemented for "${tag}". Call .implement() on the endpoint definition.`,
				);
			}
			const handler = handlerRef.current;
			const parentSpan = extractParentSpanFromPayload(args);

			let decodedArgs: Schema.Struct.Type<PayloadFields>;
			try {
				decodedArgs = decodePayload(args);
			} catch (err) {
				return encodeExit(Exit.die(err));
			}

			const middlewareOptions: MiddlewareOptions = {
				rpc: rpcInfo,
				payload: decodedArgs,
				ctx: rawCtx,
			};

			const effect = Effect.gen(function* () {
				const middlewareCtx = middlewareConfig?.implementations?.length
					? yield* executeMiddlewares(
						endpointMiddlewares,
						middlewareConfig.implementations,
						middlewareOptions,
					)
					: Context.empty();

				const handlerEffect = handler(decodedArgs as never);
				const withMiddlewareCtx = Effect.provide(handlerEffect, middlewareCtx);
				const withConfectCtx = Effect.provideService(
					withMiddlewareCtx as Effect.Effect<Schema.Schema.Type<Success>, unknown, Ctx>,
					endpointConfig.ctxTag,
					endpointConfig.makeCtx(rawCtx),
				);

				return yield* withConfectCtx;
			});

			const tracedEffect = Effect.withSpan(
				effect,
				`rpc.server.${endpointConfig.kind}.${tag}`,
				{
					kind: "server",
					captureStackTrace: false,
					parent: Option.getOrUndefined(parentSpan),
					attributes: {
						"rpc.system": "convex",
						"rpc.method": tag,
						"rpc.confect.kind": endpointConfig.kind,
					},
				},
			);

			const effectWithLayer = middlewareConfig?.staticLayer
				? Effect.gen(function* () {
					yield* StaticLayerReady;
					return yield* tracedEffect;
				}).pipe(
					Effect.provide(
						Layer.mergeAll(
							middlewareConfig.staticLayer,
							Layer.succeed(StaticLayerReady, true),
						),
					),
				)
				: tracedEffect;

			const exit = await Effect.runPromiseExit(effectWithLayer);
			return encodeExit(exit);
		};
	};

	const createUnbuiltEndpoint = <
		PayloadFields extends Schema.Struct.Fields,
		Success extends Schema.Schema.AnyNoContext,
		Error extends Schema.Schema.AnyNoContext | undefined,
		ConvexFnType,
		Middlewares extends ReadonlyArray<RpcMiddleware.TagClassAny>,
		Ctx,
	>(
		endpointConfig: EndpointConfig<Ctx, ConvexFnType>,
		mergedPayload: PayloadFields,
		successSchema: Success,
		errorSchema: Error | undefined,
		middlewares: Middlewares,
		handlerRef: HandlerRef,
	): UnbuiltRpcEndpoint<PayloadFields, Success, Error, ConvexFnType, Middlewares> => ({
		__unbuilt: true as const,
		kind: endpointConfig.kind,
		payloadFields: mergedPayload,
		successSchema: successSchema,
		errorSchema: errorSchema,
		middlewares,
		build: (tag, middlewareConfig): RpcEndpoint<string, Rpc.Any, ConvexFnType> => {
			handlerRef.tag = tag;
			const rpc = Rpc.make(tag, {
				payload: mergedPayload,
				success: successSchema,
				error: errorSchema,
			});
			const convexHandler = makeConvexHandler(
				endpointConfig,
				tag,
				mergedPayload,
				successSchema,
				errorSchema,
				middlewareConfig,
				middlewares,
				handlerRef,
			);
			const fn = endpointConfig.registrar({ args: v.any(), handler: convexHandler });
			return { _tag: tag, rpc, fn: fn as ConvexFnType };
		},
		middleware<M extends RpcMiddleware.TagClassAny>(
			middlewareTag: M,
		): UnbuiltRpcEndpoint<PayloadFields, Success, Error, ConvexFnType, [...Middlewares, M]> {
			const newMiddlewares = [...middlewares, middlewareTag] as [...Middlewares, M];
			return createUnbuiltEndpoint(
				endpointConfig,
				mergedPayload,
				successSchema,
				errorSchema,
				newMiddlewares,
				handlerRef,
			);
		},
		implement(
			handler: (
				payload: Schema.Struct.Type<PayloadFields>,
			) => Effect.Effect<
				Schema.Schema.Type<Success>,
				Error extends Schema.Schema.AnyNoContext ? Schema.Schema.Type<Error> : never,
				unknown
			>,
		): void {
			handlerRef.current = handler as HandlerFn;
		},
	});

	/**
	 * Create an endpoint definition method. The returned function takes only
	 * schemas (no handler). Call `.implement(handler)` on the result to wire
	 * the handler, potentially from a separate file.
	 */
	const createEndpointMethod = <Ctx, ConvexFnType>(
		endpointConfig: EndpointConfig<Ctx, ConvexFnType>,
	) => <
		PayloadFields extends Schema.Struct.Fields = {},
		Success extends Schema.Schema.AnyNoContext = typeof Schema.Void,
		Error extends Schema.Schema.AnyNoContext | undefined = undefined,
	>(
		options: {
			readonly payload?: PayloadFields;
			readonly success: Success;
			readonly error?: Error;
		},
	): UnbuiltRpcEndpoint<MergedPayload<PayloadFields>, Success, Error, ConvexFnType, BaseMiddlewares> => {
		const mergedPayload = { ...basePayload, ...options.payload } as MergedPayload<PayloadFields>;
		const handlerRef = createHandlerRef();
		return createUnbuiltEndpoint(
			endpointConfig,
			mergedPayload,
			options.success,
			options.error,
			baseMiddlewares as unknown as BaseMiddlewares,
			handlerRef,
		);
	};

	const queryConfig: EndpointConfig<ConfectQueryCtx<ConfectSchema>, RegisteredQuery<"public", DefaultFunctionArgs, Promise<ExitEncoded>>> = {
		kind: "query",
		ctxTag: ConfectQueryCtx<ConfectSchema>(),
		makeCtx: (ctx) => makeQueryCtx(ctx as GenericQueryCtx<GenericDataModel>, tableSchemas),
		registrar: queryGeneric,
	};

	const mutationConfig: EndpointConfig<ConfectMutationCtx<ConfectSchema>, RegisteredMutation<"public", DefaultFunctionArgs, Promise<ExitEncoded>>> = {
		kind: "mutation",
		ctxTag: ConfectMutationCtx<ConfectSchema>(),
		makeCtx: (ctx) => makeMutationCtx(ctx as GenericMutationCtx<GenericDataModel>, tableSchemas),
		registrar: mutationGeneric,
	};

	const actionConfig: EndpointConfig<ConfectActionCtx<ConfectSchema>, RegisteredAction<"public", DefaultFunctionArgs, Promise<ExitEncoded>>> = {
		kind: "action",
		ctxTag: ConfectActionCtx<ConfectSchema>(),
		makeCtx: (ctx) => makeActionCtx(ctx as GenericActionCtx<GenericDataModel>),
		registrar: actionGeneric,
	};

	const internalQueryConfig: EndpointConfig<ConfectQueryCtx<ConfectSchema>, RegisteredQuery<"internal", DefaultFunctionArgs, Promise<ExitEncoded>>> = {
		kind: "internalQuery",
		ctxTag: ConfectQueryCtx<ConfectSchema>(),
		makeCtx: (ctx) => makeQueryCtx(ctx as GenericQueryCtx<GenericDataModel>, tableSchemas),
		registrar: internalQueryGeneric,
	};

	const internalMutationConfig: EndpointConfig<ConfectMutationCtx<ConfectSchema>, RegisteredMutation<"internal", DefaultFunctionArgs, Promise<ExitEncoded>>> = {
		kind: "internalMutation",
		ctxTag: ConfectMutationCtx<ConfectSchema>(),
		makeCtx: (ctx) => makeMutationCtx(ctx as GenericMutationCtx<GenericDataModel>, tableSchemas),
		registrar: internalMutationGeneric,
	};

	const internalActionConfig: EndpointConfig<ConfectActionCtx<ConfectSchema>, RegisteredAction<"internal", DefaultFunctionArgs, Promise<ExitEncoded>>> = {
		kind: "internalAction",
		ctxTag: ConfectActionCtx<ConfectSchema>(),
		makeCtx: (ctx) => makeActionCtx(ctx as GenericActionCtx<GenericDataModel>),
		registrar: internalActionGeneric,
	};

	return {
		query: createEndpointMethod(queryConfig),
		mutation: createEndpointMethod(mutationConfig),
		action: createEndpointMethod(actionConfig),
		internalQuery: createEndpointMethod(internalQueryConfig),
		internalMutation: createEndpointMethod(internalMutationConfig),
		internalAction: createEndpointMethod(internalActionConfig),
	};
};

export type InferRpc<E> = E extends RpcEndpoint<infer _Tag, infer R, infer _ConvexFn> ? R : never;

export type InferFn<E> = E extends RpcEndpoint<infer _Tag, infer _R, infer ConvexFn> ? ConvexFn : never;

interface RpcModuleBase<
	Endpoints extends Record<string, RpcEndpoint<string, Rpc.Any, unknown>>,
> {
	readonly _def: {
		readonly endpoints: Endpoints;
	};
	readonly rpcs: { [K in keyof Endpoints]: InferRpc<Endpoints[K]> };
	readonly handlers: { [K in keyof Endpoints]: InferFn<Endpoints[K]> };
	readonly group: RpcGroup.RpcGroup<InferRpc<Endpoints[keyof Endpoints]>>;
}

export type RpcModule<
	Endpoints extends Record<string, RpcEndpoint<string, Rpc.Any, unknown>>,
> = RpcModuleBase<Endpoints> & Endpoints;

export interface AnyRpcModule {
	readonly _def: {
		readonly endpoints: Record<string, RpcEndpoint<string, Rpc.Any, unknown>>;
	};
	readonly rpcs: Record<string, Rpc.Any>;
	readonly handlers: Record<string, unknown>;
	readonly group: unknown;
}

export type InferModuleEndpoints<M extends AnyRpcModule> = M["_def"]["endpoints"];

interface AnyUnbuiltEndpoint {
	readonly __unbuilt: true;
	readonly kind: string;
	readonly payloadFields: Schema.Struct.Fields;
	readonly successSchema: Schema.Schema.AnyNoContext;
	readonly errorSchema: Schema.Schema.AnyNoContext | undefined;
	readonly middlewares: ReadonlyArray<RpcMiddleware.TagClassAny>;
	readonly build: (tag: string, middlewareConfig: MiddlewareConfig | undefined) => RpcEndpoint<string, Rpc.Any, unknown>;
	middleware<M extends RpcMiddleware.TagClassAny>(middleware: M): AnyUnbuiltEndpoint;
	// Variance note: `implement` sits in covariant position (method), its handler
	// parameter is contravariant, and the handler's `payload` is again contravariant
	// — making `payload` doubly contravariant = covariant overall. So for
	// `AnyUnbuiltEndpoint` to be a proper supertype of all concrete endpoints,
	// `payload` must be a supertype of all concrete payload types → `unknown`.
	implement(handler: (payload: unknown) => Effect.Effect<unknown, unknown, unknown>): void;
}

type BuiltEndpoint<K extends string, U> = U extends UnbuiltRpcEndpoint<
	infer PayloadFields,
	infer Success,
	infer Error,
	infer ConvexFnType,
	infer _Middlewares
>
	? RpcEndpoint<K, Rpc.Rpc<K, Schema.Struct<PayloadFields>, Success, Error extends Schema.Schema.AnyNoContext ? Error : typeof Schema.Never, never>, ConvexFnType>
	: never;

type BuiltEndpoints<T extends Record<string, AnyUnbuiltEndpoint>> = {
	[K in keyof T & string]: BuiltEndpoint<K, T[K]>;
};

const isUnbuilt = (value: unknown): value is AnyUnbuiltEndpoint =>
	typeof value === "object" && value !== null && "__unbuilt" in value && (value as { __unbuilt: unknown }).__unbuilt === true;

type ExtractMiddlewares<T extends Record<string, AnyUnbuiltEndpoint>> = T[keyof T]["middlewares"][number];

type ExtractMiddlewareProvides<T extends RpcMiddleware.TagClassAny> = T extends {
	readonly provides: Context.Tag<infer Id, infer _S>;
}
	? Id
	: never;

type ExtractAllMiddlewareProvides<T extends Record<string, AnyUnbuiltEndpoint>> = ExtractMiddlewareProvides<ExtractMiddlewares<T>>;

type StaticMiddlewareLayer<Services> =
	| Layer.Layer<Services, unknown, never>
	| Layer.Layer<never, unknown, never>;

export interface RpcModuleOptions<Services> {
	readonly middlewares?: 
		| StaticMiddlewareLayer<Services>
		| ReadonlyArray<MiddlewareImplementation>
		| {
			readonly implementations?: ReadonlyArray<MiddlewareImplementation>;
			readonly layer?: StaticMiddlewareLayer<Services>;
		};
}

const normalizeMiddlewareOptions = <Services>(
	options: RpcModuleOptions<Services>["middlewares"],
): MiddlewareConfig | undefined => {
	if (!options) {
		return undefined;
	}

	if (Array.isArray(options)) {
		return {
			implementations: options,
			staticLayer: undefined,
		};
	}

	if ("_tag" in options && options._tag === "MiddlewareImplementation") {
		return {
			implementations: [options as MiddlewareImplementation],
			staticLayer: undefined,
		};
	}

	if (Layer.isLayer(options)) {
		return {
			implementations: [],
			staticLayer: options as Layer.Layer<unknown, unknown, never>,
		};
	}

	const cfg = options as {
		readonly implementations?: ReadonlyArray<MiddlewareImplementation>;
		readonly layer?: StaticMiddlewareLayer<Services>;
	};
	
	return {
		implementations: cfg.implementations ?? [],
		staticLayer: cfg.layer as Layer.Layer<unknown, unknown, never> | undefined,
	};
};

export function makeRpcModule<
	const T extends Record<string, AnyUnbuiltEndpoint>,
>(
	unbuiltEndpoints: T,
	options?: RpcModuleOptions<ExtractAllMiddlewareProvides<T>>,
): RpcModuleBase<BuiltEndpoints<T>> & { readonly [K in keyof T]: BuiltEndpoint<K & string, T[K]> } {
	const rpcs = {} as Record<string, Rpc.Any>;
	const handlers = {} as Record<string, unknown>;
	const rpcList: Array<Rpc.Any> = [];
	const builtEndpoints = {} as Record<string, RpcEndpoint<string, Rpc.Any, unknown>>;

	const middlewareConfig = normalizeMiddlewareOptions(options?.middlewares);

	for (const key of Object.keys(unbuiltEndpoints)) {
		const unbuilt = unbuiltEndpoints[key]!;
		if (!isUnbuilt(unbuilt)) {
			throw new Error(`Expected unbuilt endpoint for key "${key}"`);
		}
		const endpoint = unbuilt.build(key, middlewareConfig);
		builtEndpoints[key] = endpoint;
		rpcs[key] = endpoint.rpc;
		handlers[key] = endpoint.fn;
		rpcList.push(endpoint.rpc);
	}

	type Built = BuiltEndpoints<T>;
	const module = {
		_def: { endpoints: builtEndpoints },
		rpcs: rpcs as { [K in keyof Built]: InferRpc<Built[K]> },
		handlers: handlers as { [K in keyof Built]: InferFn<Built[K]> },
		group: RpcGroup.make(...rpcList) as unknown as RpcGroup.RpcGroup<InferRpc<Built[keyof Built]>>,
	};

	return Object.assign(module, builtEndpoints) as RpcModuleBase<Built> & { readonly [K in keyof T]: BuiltEndpoint<K & string, T[K]> };
}

export const exitSchema = Rpc.exitSchema;
