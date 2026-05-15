import { Context, Data, Effect, Layer, Predicate, Schema } from "effect";
import { HttpClient, HttpServer } from "effect/unstable/http";
import {
  ScopeId,
  type CredentialBindingsFacade,
  type CredentialBindingValue,
} from "@executor-js/sdk";

export class OpenApiTestServerAddressError extends Data.TaggedError(
  "OpenApiTestServerAddressError",
)<{
  readonly address: unknown;
}> {}

export class OpenApiTestServerSpecError extends Data.TaggedError("OpenApiTestServerSpecError")<{
  readonly cause: unknown;
}> {}

export interface OpenApiTestServerOptions {
  readonly spec: unknown;
}

export interface OpenApiTestServerShape {
  readonly baseUrl: string;
  readonly specJson: string;
  readonly httpClientLayer: Layer.Layer<HttpClient.HttpClient, never, never>;
}

const decodeJsonSpec = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const isJsonObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const openApiSpecJsonWithServer = (
  spec: unknown,
  baseUrl: string,
): Effect.Effect<string, OpenApiTestServerSpecError> =>
  Effect.gen(function* () {
    const parsed =
      typeof spec === "string"
        ? yield* decodeJsonSpec(spec).pipe(
            Effect.mapError((cause) => new OpenApiTestServerSpecError({ cause })),
          )
        : spec;
    const withServer = isJsonObject(parsed)
      ? {
          ...parsed,
          servers: [{ url: baseUrl }],
        }
      : parsed;
    return yield* Effect.try({
      try: () => JSON.stringify(withServer),
      catch: (cause) => new OpenApiTestServerSpecError({ cause }),
    });
  });

export const makeOpenApiTestServer = (
  options: OpenApiTestServerOptions,
): Effect.Effect<
  OpenApiTestServerShape,
  OpenApiTestServerAddressError | OpenApiTestServerSpecError,
  HttpClient.HttpClient | HttpServer.HttpServer
> =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const address = server.address;
    if (!Predicate.isTagged(address, "TcpAddress")) {
      return yield* new OpenApiTestServerAddressError({ address });
    }

    const client = yield* HttpClient.HttpClient;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const specJson = yield* openApiSpecJsonWithServer(options.spec, baseUrl);

    return {
      baseUrl,
      specJson,
      httpClientLayer: Layer.succeed(HttpClient.HttpClient, client),
    };
  });

export class OpenApiTestServer extends Context.Service<OpenApiTestServer, OpenApiTestServerShape>()(
  "@executor-js/plugin-openapi/testing/OpenApiTestServer",
) {
  static readonly layer = (options: OpenApiTestServerOptions) =>
    Layer.effect(OpenApiTestServer, makeOpenApiTestServer(options));
}

export const TestLayers = {
  server: OpenApiTestServer.layer,
};

type ScopeInput = ScopeId | string;

const scopeId = (scope: ScopeInput): ScopeId => ScopeId.make(String(scope));

export interface OpenApiTestCredentialBindingInput {
  readonly sourceId: string;
  readonly sourceScope: ScopeInput;
  readonly targetScope: ScopeInput;
  readonly slotKey: string;
  readonly value: CredentialBindingValue;
}

export const setOpenApiCredentialBinding = (
  executor: { readonly credentialBindings: CredentialBindingsFacade },
  input: OpenApiTestCredentialBindingInput,
): ReturnType<CredentialBindingsFacade["set"]> =>
  executor.credentialBindings.set({
    targetScope: scopeId(input.targetScope),
    pluginId: "openapi",
    sourceId: input.sourceId,
    sourceScope: scopeId(input.sourceScope),
    slotKey: input.slotKey,
    value: input.value,
  });

export interface OpenApiTestCredentialBindingSourceInput {
  readonly sourceId: string;
  readonly sourceScope: ScopeInput;
}

export const listOpenApiCredentialBindings = (
  executor: { readonly credentialBindings: CredentialBindingsFacade },
  input: OpenApiTestCredentialBindingSourceInput,
): ReturnType<CredentialBindingsFacade["listForSource"]> =>
  executor.credentialBindings.listForSource({
    pluginId: "openapi",
    sourceId: input.sourceId,
    sourceScope: scopeId(input.sourceScope),
  });

export interface OpenApiTestRemoveCredentialBindingInput extends OpenApiTestCredentialBindingSourceInput {
  readonly targetScope: ScopeInput;
  readonly slotKey: string;
}

export const removeOpenApiCredentialBinding = (
  executor: { readonly credentialBindings: CredentialBindingsFacade },
  input: OpenApiTestRemoveCredentialBindingInput,
): ReturnType<CredentialBindingsFacade["remove"]> =>
  executor.credentialBindings.remove({
    targetScope: scopeId(input.targetScope),
    pluginId: "openapi",
    sourceId: input.sourceId,
    sourceScope: scopeId(input.sourceScope),
    slotKey: input.slotKey,
  });
