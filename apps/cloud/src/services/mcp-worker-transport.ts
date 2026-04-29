import { WorkerTransport, type WorkerTransportOptions } from "agents/mcp";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Data, Effect } from "effect";

export class McpWorkerTransportError extends Data.TaggedError("McpWorkerTransportError")<{
  readonly cause: unknown;
}> {}

export type McpWorkerTransport = Readonly<{
  transport: WorkerTransport;
  connect: (server: McpServer) => Effect.Effect<void, McpWorkerTransportError>;
  handleRequest: (request: Request) => Effect.Effect<Response, McpWorkerTransportError>;
  close: () => Effect.Effect<void>;
}>;

type WorkerTransportInternals = {
  readonly standaloneSseStreamId?: string;
  readonly streamMapping?: Map<string, { readonly cleanup?: () => void }>;
};

type JsonRpcLike = {
  readonly id?: unknown;
  readonly method?: unknown;
};

type HandleRequestResult = {
  readonly response: Response;
  readonly replacedStandaloneSse: boolean;
};

const closeExistingStandaloneSse = (transport: WorkerTransport): boolean => {
  const internals = transport as unknown as WorkerTransportInternals;
  const streamId = internals.standaloneSseStreamId ?? "_GET_stream";
  const stream = internals.streamMapping?.get(streamId);
  if (!stream) return false;

  stream.cleanup?.();
  internals.streamMapping?.delete(streamId);
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

const extractJsonRpcRequestIdKeys = async (request: Request): Promise<ReadonlyArray<string>> => {
  if (request.method !== "POST") return [];
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return [];

  try {
    const parsed = (await request.clone().json()) as unknown;
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    return messages.flatMap((message) => {
      if (!message || typeof message !== "object") return [];
      const rpc = message as JsonRpcLike;
      if (typeof rpc.method !== "string") return [];
      const key = jsonRpcRequestIdKey(rpc.id);
      return key ? [key] : [];
    });
  } catch {
    return [];
  }
};

class JsonRpcRequestIdQueue {
  private readonly inFlight = new Map<string, Promise<void>>();

  async run<A>(request: Request, run: () => Promise<A>): Promise<A> {
    const ids = [...new Set(await extractJsonRpcRequestIdKeys(request))];
    if (ids.length === 0) return await run();

    const previous = ids.map((id) => this.inFlight.get(id)).filter((p) => p !== undefined);
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    for (const id of ids) {
      this.inFlight.set(id, current);
    }

    try {
      await Promise.all(previous.map((p) => p.catch(() => undefined)));
      return await run();
    } finally {
      for (const id of ids) {
        if (this.inFlight.get(id) === current) {
          this.inFlight.delete(id);
        }
      }
      release();
    }
  }
}

export const makeMcpWorkerTransport = (
  options: WorkerTransportOptions,
): Effect.Effect<McpWorkerTransport> =>
  Effect.sync(() => {
    const transport = new WorkerTransport(options);
    const requestIdQueue = new JsonRpcRequestIdQueue();

    const use = <A>(name: string, fn: () => Promise<A>) =>
      Effect.tryPromise({
        try: fn,
        catch: (cause) => new McpWorkerTransportError({ cause }),
      }).pipe(Effect.withSpan(`mcp.worker_transport.${name}`));

    const handleWithStandaloneSseReplacement = async (
      request: Request,
    ): Promise<HandleRequestResult> => {
      if (!isStandaloneSseGet(request)) {
        return {
          response: await transport.handleRequest(request),
          replacedStandaloneSse: false,
        };
      }

      const initial = await transport.handleRequest(request);
      if (initial.status !== 409) {
        return { response: initial, replacedStandaloneSse: false };
      }

      const replacedStandaloneSse = closeExistingStandaloneSse(transport);
      return {
        response: replacedStandaloneSse ? await transport.handleRequest(request) : initial,
        replacedStandaloneSse,
      };
    };

    return {
      transport,
      connect: (server: McpServer) => use("connect", () => server.connect(transport)),
      handleRequest: (request: Request) =>
        Effect.gen(function* () {
          const result = yield* use("handle_request", () =>
            requestIdQueue.run(request, () => handleWithStandaloneSseReplacement(request)),
          );
          yield* Effect.annotateCurrentSpan({
            "mcp.transport.replaced_standalone_sse": result.replacedStandaloneSse,
          });
          return result.response;
        }),
      close: () =>
        Effect.promise(() => transport.close().catch(() => undefined)).pipe(
          Effect.withSpan("mcp.worker_transport.close"),
          Effect.orDie,
        ),
    } satisfies McpWorkerTransport;
  }).pipe(Effect.withSpan("mcp.worker_transport.make"));
