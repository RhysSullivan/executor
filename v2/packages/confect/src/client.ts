import type { FunctionReference, FunctionReturnType } from "convex/server";
import {
	ConvexClient as ConvexClientImpl,
	ConvexHttpClient,
} from "convex/browser";
import { Context, Effect, Layer, Stream } from "effect";

export interface ConvexRequestMetadata {
	readonly headers?: Readonly<Record<string, string>>;
}

export interface ConvexClientService {
	query<Query extends FunctionReference<"query">>(
		query: Query,
		args: Query["_args"],
		requestMetadata?: ConvexRequestMetadata,
	): Effect.Effect<FunctionReturnType<Query>>;

	mutation<Mutation extends FunctionReference<"mutation">>(
		mutation: Mutation,
		args: Mutation["_args"],
		requestMetadata?: ConvexRequestMetadata,
	): Effect.Effect<FunctionReturnType<Mutation>>;

	action<Action extends FunctionReference<"action">>(
		action: Action,
		args: Action["_args"],
		requestMetadata?: ConvexRequestMetadata,
	): Effect.Effect<FunctionReturnType<Action>>;

	subscribe<Query extends FunctionReference<"query">>(
		query: Query,
		args: Query["_args"],
	): Stream.Stream<FunctionReturnType<Query>>;
}

export class ConvexClient extends Context.Tag("@confect/ConvexClient")<
	ConvexClient,
	ConvexClientService
>() {}

export const ConvexClientLayer = (
	url: string,
): Layer.Layer<ConvexClient> => {
	const wsClient = new ConvexClientImpl(url);

	// Shared HTTP client instance — no custom headers that would trigger CORS
	// preflight failures in browsers. Telemetry context is already embedded
	// in the payload by `withOptionalRpcTelemetryContext`, so transport-level
	// headers are not needed for browser clients.
	const httpClient = new ConvexHttpClient(url);

	const syncAuth = () => {
		const auth = wsClient.getAuth();
		if (auth !== undefined) {
			httpClient.setAuth(auth.token);
		}
	};

	const service: ConvexClientService = {
		query: <Query extends FunctionReference<"query">>(
			query: Query,
			args: Query["_args"],
			_requestMetadata?: ConvexRequestMetadata,
		): Effect.Effect<FunctionReturnType<Query>> =>
			Effect.promise(() => {
				syncAuth();
				return httpClient.query(query, args);
			}),

		mutation: <Mutation extends FunctionReference<"mutation">>(
			mutation: Mutation,
			args: Mutation["_args"],
			_requestMetadata?: ConvexRequestMetadata,
		): Effect.Effect<FunctionReturnType<Mutation>> =>
			Effect.promise(() => {
				syncAuth();
				return httpClient.mutation(mutation, args);
			}),

		action: <Action extends FunctionReference<"action">>(
			action: Action,
			args: Action["_args"],
			_requestMetadata?: ConvexRequestMetadata,
		): Effect.Effect<FunctionReturnType<Action>> =>
			Effect.promise(() => {
				syncAuth();
				return httpClient.action(action, args);
			}),

		subscribe: <Query extends FunctionReference<"query">>(
			query: Query,
			args: Query["_args"],
		): Stream.Stream<FunctionReturnType<Query>> =>
			Stream.async<FunctionReturnType<Query>>((emit) => {
				const unsubscribe = wsClient.onUpdate(query, args, (result) => {
					emit.single(result);
				});
				return Effect.sync(() => {
					unsubscribe();
				});
			}),
	};

	return Layer.succeed(ConvexClient, service);
};

/**
 * Server-only layer that uses only `ConvexHttpClient` (no WebSocket).
 * Safe for use in Next.js server components, route handlers, and server actions.
 * Subscriptions are not supported and will fail with a defect if called.
 */
export const ConvexHttpClientLayer = (
	url: string,
	config: {
		readonly authToken?: string;
	} = {},
): Layer.Layer<ConvexClient> => {
	const httpClient = new ConvexHttpClient(url);
	if (config.authToken !== undefined && config.authToken.length > 0) {
		httpClient.setAuth(config.authToken);
	}

	const service: ConvexClientService = {
		query: <Query extends FunctionReference<"query">>(
			query: Query,
			args: Query["_args"],
			_requestMetadata?: ConvexRequestMetadata,
		): Effect.Effect<FunctionReturnType<Query>> =>
			Effect.promise(() => httpClient.query(query, args)),

		mutation: <Mutation extends FunctionReference<"mutation">>(
			mutation: Mutation,
			args: Mutation["_args"],
			_requestMetadata?: ConvexRequestMetadata,
		): Effect.Effect<FunctionReturnType<Mutation>> =>
			Effect.promise(() => httpClient.mutation(mutation, args)),

		action: <Action extends FunctionReference<"action">>(
			action: Action,
			args: Action["_args"],
			_requestMetadata?: ConvexRequestMetadata,
		): Effect.Effect<FunctionReturnType<Action>> =>
			Effect.promise(() => httpClient.action(action, args)),

		subscribe: <Query extends FunctionReference<"query">>(
			_query: Query,
			_args: Query["_args"],
		): Stream.Stream<FunctionReturnType<Query>> =>
			Stream.fromEffect(
				Effect.die(
					new Error(
						"ConvexHttpClientLayer does not support subscriptions. Use ConvexClientLayer (with WebSocket) for real-time subscriptions.",
					),
				),
			),
	};

	return Layer.succeed(ConvexClient, service);
};
