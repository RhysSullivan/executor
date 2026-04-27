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

export const makeMcpWorkerTransport = (
  options: WorkerTransportOptions,
): Effect.Effect<McpWorkerTransport> =>
  Effect.sync(() => {
    const transport = new WorkerTransport(options);

    const use = <A>(name: string, fn: () => Promise<A>) =>
      Effect.tryPromise({
        try: fn,
        catch: (cause) => new McpWorkerTransportError({ cause }),
      }).pipe(Effect.withSpan(`mcp.worker_transport.${name}`));

    return {
      transport,
      connect: (server: McpServer) => use("connect", () => server.connect(transport)),
      handleRequest: (request: Request) =>
        use("handle_request", () => transport.handleRequest(request)),
      close: () =>
        Effect.promise(() => transport.close().catch(() => undefined)).pipe(
          Effect.withSpan("mcp.worker_transport.close"),
          Effect.orDie,
        ),
    } satisfies McpWorkerTransport;
  }).pipe(Effect.withSpan("mcp.worker_transport.make"));
