import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  WebStandardStreamableHTTPServerTransport,
  type WebStandardStreamableHTTPServerTransportOptions,
} from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  isInitializeRequest,
  JSONRPCMessageSchema,
  type InitializeRequestParams,
} from "@modelcontextprotocol/sdk/types.js";
import { Data, Effect, Exit } from "effect";

export class McpWorkerTransportError extends Data.TaggedError("McpWorkerTransportError")<{
  readonly cause: unknown;
}> {}

export type McpTransportState = {
  readonly sessionId?: string;
  readonly initialized?: boolean;
  readonly initializeParams?: InitializeRequestParams;
};

export type McpWorkerTransportOptions = WebStandardStreamableHTTPServerTransportOptions & {
  readonly storage?: {
    readonly get: () => Effect.Effect<McpTransportState | undefined, unknown>;
    readonly set: (state: McpTransportState) => Effect.Effect<void, unknown>;
  };
};

export type McpWorkerTransport = Readonly<{
  transport: WebStandardStreamableHTTPServerTransport;
  connect: (server: McpServer) => Effect.Effect<void, McpWorkerTransportError>;
  handleRequest: (request: Request) => Effect.Effect<Response, McpWorkerTransportError>;
  close: () => Effect.Effect<void>;
}>;

type JsonRpcLike = {
  readonly id?: unknown;
  readonly method?: unknown;
};

type HandleRequestResult = {
  readonly response: Response;
  readonly replacedStandaloneSse: boolean;
};

const closeExistingStandaloneSse = (
  transport: WebStandardStreamableHTTPServerTransport,
): boolean => {
  const streamId =
    typeof Reflect.get(transport, "_standaloneSseStreamId") === "string"
      ? Reflect.get(transport, "_standaloneSseStreamId")
      : "_GET_stream";
  const streamMapping = Reflect.get(transport, "_streamMapping");
  if (!(streamMapping instanceof Map)) return false;

  const stream = streamMapping.get(streamId);
  if (!stream) return false;

  if (
    typeof stream === "object" &&
    stream !== null &&
    typeof Reflect.get(stream, "cleanup") === "function"
  ) {
    Reflect.get(stream, "cleanup")();
  }
  streamMapping.delete(streamId);
  return true;
};

const isStandaloneSseGet = (request: Request): boolean =>
  request.method === "GET" && (request.headers.get("accept") ?? "").includes("text/event-stream");

const jsonRpcRequestIdKey = (id: unknown): string | null => {
  switch (typeof id) {
    case "string":
    case "number":
    case "boolean":
      return `${typeof id}:${String(id)}`;
    default:
      return null;
  }
};

const extractJsonRpcRequestIdKeys = (request: Request): Effect.Effect<ReadonlyArray<string>> =>
  Effect.gen(function* () {
    if (request.method !== "POST") return [];
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) return [];

    const parsedExit = yield* Effect.exit(Effect.tryPromise(() => request.clone().json()));
    if (Exit.isFailure(parsedExit)) return [];
    const parsed = parsedExit.value;
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    return messages.flatMap((message) => {
      if (!message || typeof message !== "object") return [];
      const rpc = message as JsonRpcLike;
      if (typeof rpc.method !== "string") return [];
      const key = jsonRpcRequestIdKey(rpc.id);
      return key ? [key] : [];
    });
  });

const extractInitializeParams = (
  request: Request,
): Effect.Effect<McpTransportState["initializeParams"] | undefined, McpWorkerTransportError> =>
  Effect.gen(function* () {
    if (request.method !== "POST") return undefined;
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) return undefined;

    const parsed = yield* Effect.tryPromise({
      try: () => request.clone().json(),
      catch: (cause) => new McpWorkerTransportError({ cause }),
    });

    const messages = Array.isArray(parsed) ? parsed : [parsed];
    for (const message of messages) {
      const decoded = yield* Effect.exit(
        Effect.try({
          try: () => JSONRPCMessageSchema.parse(message),
          catch: (cause) => new McpWorkerTransportError({ cause }),
        }),
      );
      if (Exit.isSuccess(decoded) && isInitializeRequest(decoded.value)) {
        return {
          capabilities: decoded.value.params.capabilities,
          clientInfo: decoded.value.params.clientInfo,
          protocolVersion: decoded.value.params.protocolVersion,
        };
      }
    }
    return undefined;
  });

// Hard ceiling on how long a same-id JSON-RPC request will wait for an
// earlier in-flight one to finish. Stays well under the 180s upstream
// client timeout that Claude / Cowork enforce, so a poisoned queue slot
// can't block the next request long enough for the client to give up.
// If a previous request hasn't released within the budget, we proceed
// anyway — at worst the MCP SDK rejects the second reply for a duplicate
// id, which is recoverable; a perma-stuck queue is not.
export const PREVIOUS_REQUEST_TIMEOUT_MS = 60_000;

export type JsonRpcRequestIdQueue = Readonly<{
  run: <A, E = never, R = never>(
    request: Request,
    run: () => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}>;

export const makeJsonRpcRequestIdQueue = (
  options: { readonly previousTimeoutMs?: number } = {},
): JsonRpcRequestIdQueue => {
  const inFlight = new Map<string, Promise<void>>();
  const previousTimeoutMs = options.previousTimeoutMs ?? PREVIOUS_REQUEST_TIMEOUT_MS;

  return {
    run: (request, run) =>
      Effect.gen(function* () {
        const ids = [...new Set(yield* extractJsonRpcRequestIdKeys(request))];
        if (ids.length === 0) return yield* run();

        const previous = ids.map((id) => inFlight.get(id)).filter((p) => p !== undefined);
        let release!: () => void;
        const current = new Promise<void>((resolve) => {
          release = resolve;
        });
        for (const id of ids) {
          inFlight.set(id, current);
        }

        return yield* Effect.gen(function* () {
          if (previous.length > 0) {
            const outcome = yield* Effect.promise(() => {
              const settled = Promise.all(previous);
              const timeout = new Promise<"timeout">((resolve) =>
                setTimeout(() => resolve("timeout"), previousTimeoutMs),
              );
              return Promise.race([settled.then(() => "settled" as const), timeout]);
            });
            if (outcome === "timeout") {
              console.warn(
                `[mcp-worker-transport] previous in-flight request for ids=${ids.join(",")} did not release within ${previousTimeoutMs}ms; proceeding anyway`,
              );
            }
          }
          return yield* run();
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              for (const id of ids) {
                if (inFlight.get(id) === current) {
                  inFlight.delete(id);
                }
              }
              release();
            }),
          ),
        );
      }),
  };
};

export const makeMcpWorkerTransport = (
  options: McpWorkerTransportOptions,
): Effect.Effect<McpWorkerTransport> =>
  Effect.sync(() => {
    const { storage, ...transportOptions } = options;
    const transport = new WebStandardStreamableHTTPServerTransport(transportOptions);
    const requestIdQueue = makeJsonRpcRequestIdQueue();

    const use = <A>(name: string, fn: () => Promise<A>) =>
      Effect.tryPromise({
        try: fn,
        catch: (cause) => new McpWorkerTransportError({ cause }),
      }).pipe(Effect.withSpan(`mcp.worker_transport.${name}`));

    const restoreState = Effect.gen(function* () {
      const state = storage
        ? yield* storage
            .get()
            .pipe(Effect.mapError((cause) => new McpWorkerTransportError({ cause })))
        : undefined;
      if (!state?.initialized) return;
      transport.sessionId = state.sessionId;
      Reflect.set(transport, "_initialized", true);
      if (state.initializeParams && transport.onmessage) {
        transport.onmessage({
          jsonrpc: "2.0",
          id: "__restore__",
          method: "initialize",
          params: state.initializeParams,
        });
      }
    });

    const saveStateFromInitializeParams = (
      initializeParams: McpTransportState["initializeParams"] | undefined,
      response: Response,
    ) =>
      Effect.gen(function* () {
        if (!storage || response.status >= 400) return;
        if (!initializeParams) return;
        yield* storage
          .set({
            sessionId: transport.sessionId,
            initialized: true,
            initializeParams,
          })
          .pipe(Effect.mapError((cause) => new McpWorkerTransportError({ cause })));
      });

    const handleWithStandaloneSseReplacement = (
      request: Request,
    ): Effect.Effect<HandleRequestResult, McpWorkerTransportError> =>
      Effect.gen(function* () {
        if (!isStandaloneSseGet(request)) {
          return {
            response: yield* use("handle_request_raw", () => transport.handleRequest(request)),
            replacedStandaloneSse: false,
          };
        }

        const initial = yield* use("handle_request_raw", () => transport.handleRequest(request));
        if (initial.status !== 409) {
          return { response: initial, replacedStandaloneSse: false };
        }

        const replacedStandaloneSse = closeExistingStandaloneSse(transport);
        return {
          response: replacedStandaloneSse
            ? yield* use("handle_request_raw", () => transport.handleRequest(request))
            : initial,
          replacedStandaloneSse,
        };
      });

    return {
      transport,
      connect: (server: McpServer) =>
        use("connect", () => server.connect(transport)).pipe(Effect.andThen(restoreState)),
      handleRequest: (request: Request) =>
        Effect.gen(function* () {
          const initializeParams = yield* extractInitializeParams(request);
          const result = yield* requestIdQueue.run(request, () =>
            handleWithStandaloneSseReplacement(request),
          );
          yield* saveStateFromInitializeParams(initializeParams, result.response).pipe(
            Effect.withSpan("mcp.worker_transport.save_state"),
          );
          yield* Effect.annotateCurrentSpan({
            "mcp.transport.replaced_standalone_sse": result.replacedStandaloneSse,
          });
          return result.response;
        }),
      close: () =>
        Effect.ignore(
          Effect.tryPromise({
            try: () => transport.close(),
            catch: (cause) => new McpWorkerTransportError({ cause }),
          }),
        ).pipe(Effect.withSpan("mcp.worker_transport.close")),
    } satisfies McpWorkerTransport;
  }).pipe(Effect.withSpan("mcp.worker_transport.make"));
