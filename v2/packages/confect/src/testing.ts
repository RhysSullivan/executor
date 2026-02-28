import type { FunctionReference, FunctionReturnType, SchemaDefinition, GenericSchema } from "convex/server";
import { Effect, Layer, Stream } from "effect";
import {
	ConvexClient,
	type ConvexClientService,
	type ConvexRequestMetadata,
} from "./client";

export interface ConvexTestInstance {
	query<Query extends FunctionReference<"query">>(
		query: Query,
		args: Query["_args"],
	): Promise<FunctionReturnType<Query>>;

	mutation<Mutation extends FunctionReference<"mutation">>(
		mutation: Mutation,
		args: Mutation["_args"],
	): Promise<FunctionReturnType<Mutation>>;

	action<Action extends FunctionReference<"action">>(
		action: Action,
		args: Action["_args"],
	): Promise<FunctionReturnType<Action>>;

	onUpdate<Query extends FunctionReference<"query">>(
		query: Query,
		args: Query["_args"],
		callback: (result: FunctionReturnType<Query>) => void,
	): () => void;

	run<Output>(
		func: (ctx: { db: unknown; storage: unknown }) => Promise<Output>,
	): Promise<Output>;
}

export const ConvexClientTestLayer = (
	testClient: ConvexTestInstance,
): Layer.Layer<ConvexClient> => {
	const service: ConvexClientService = {
		query: <Query extends FunctionReference<"query">>(
			query: Query,
			args: Query["_args"],
			_requestMetadata?: ConvexRequestMetadata,
		): Effect.Effect<FunctionReturnType<Query>> =>
			Effect.promise(() => testClient.query(query, args)),

		mutation: <Mutation extends FunctionReference<"mutation">>(
			mutation: Mutation,
			args: Mutation["_args"],
			_requestMetadata?: ConvexRequestMetadata,
		): Effect.Effect<FunctionReturnType<Mutation>> =>
			Effect.promise(() => testClient.mutation(mutation, args)),

		action: <Action extends FunctionReference<"action">>(
			action: Action,
			args: Action["_args"],
			_requestMetadata?: ConvexRequestMetadata,
		): Effect.Effect<FunctionReturnType<Action>> =>
			Effect.promise(() => testClient.action(action, args)),

		subscribe: <Query extends FunctionReference<"query">>(
			query: Query,
			args: Query["_args"],
		): Stream.Stream<FunctionReturnType<Query>> =>
			Stream.async<FunctionReturnType<Query>>((emit) => {
				const unsubscribe = testClient.onUpdate(query, args, (result) => {
					emit.single(result);
				});
				return Effect.sync(() => {
					unsubscribe();
				});
			}),
	};

	return Layer.succeed(ConvexClient, service);
};

export interface ConvexTestFactory {
	<SchemaDef extends SchemaDefinition<GenericSchema, boolean>>(
		schema: SchemaDef,
		modules?: Record<string, () => Promise<unknown>>,
	): ConvexTestInstance;
}

export interface MakeTestLayerOptions<SchemaDef extends SchemaDefinition<GenericSchema, boolean>> {
	readonly schema: SchemaDef;
	readonly modules?: Record<string, () => Promise<unknown>>;
	readonly convexTest: ConvexTestFactory;
}

export interface ConvexTestLayer extends Layer.Layer<ConvexClient> {
	readonly testClient: ConvexTestInstance;
}

export const makeTestLayer = <SchemaDef extends SchemaDefinition<GenericSchema, boolean>>(
	options: MakeTestLayerOptions<SchemaDef>,
): ConvexTestLayer => {
	const testClient = options.convexTest(options.schema, options.modules);
	const layer = ConvexClientTestLayer(testClient);
	return Object.assign(layer, { testClient });
};

export interface CreateTestContextOptions<SchemaDef extends SchemaDefinition<GenericSchema, boolean>> {
	readonly schema: SchemaDef;
	readonly modules?: Record<string, () => Promise<unknown>>;
	readonly convexTest: ConvexTestFactory;
}

export interface TestContext {
	readonly layer: Layer.Layer<ConvexClient>;
	readonly testClient: ConvexTestInstance;
	readonly runEffect: <A, E>(effect: Effect.Effect<A, E, ConvexClient>) => Promise<A>;
}

export const createTestContext = <SchemaDef extends SchemaDefinition<GenericSchema, boolean>>(
	options: CreateTestContextOptions<SchemaDef>,
): TestContext => {
	const testClient = options.convexTest(options.schema, options.modules);
	const layer = ConvexClientTestLayer(testClient);

	const runEffect = <A, E>(effect: Effect.Effect<A, E, ConvexClient>): Promise<A> =>
		Effect.runPromise(Effect.provide(effect, layer));

	return {
		layer,
		testClient,
		runEffect,
	};
};
