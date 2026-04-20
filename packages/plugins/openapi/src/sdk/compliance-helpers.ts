// ---------------------------------------------------------------------------
// Shared helpers for the OpenAPI compliance test matrix.
//
// The pattern is deliberately low-level:
//  - stand up a raw node:http echo server so the test can observe EXACTLY
//    what the plugin put on the wire (method, path, query, headers, body)
//  - hand-author a minimal OpenAPI spec that isolates one feature
//  - invoke via the real executor + plugin + FetchHttpClient.layer
//  - assert on wire bytes
//
// This module exports the common plumbing so each feature test stays focused
// on the one thing it's documenting.
// ---------------------------------------------------------------------------

import { Effect } from "effect";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

import {
  definePlugin,
  type SecretProvider,
} from "@executor/sdk";

// ---------------------------------------------------------------------------
// In-memory secret provider plugin — suffices for any test that exercises
// secret-resolved headers. Tests that don't touch secrets can still include
// this without penalty.
// ---------------------------------------------------------------------------

export const memorySecretProvider = (): SecretProvider => {
  const store = new Map<string, string>();
  return {
    key: "memory",
    writable: true,
    get: (id, scope) =>
      Effect.sync(() => store.get(`${scope}\u0000${id}`) ?? null),
    set: (id, value, scope) =>
      Effect.sync(() => {
        store.set(`${scope}\u0000${id}`, value);
      }),
    delete: (id, scope) =>
      Effect.sync(() => store.delete(`${scope}\u0000${id}`)),
    list: () => Effect.sync(() => []),
  };
};

export const memorySecretsPlugin = definePlugin(() => ({
  id: "memory-secrets" as const,
  storage: () => ({}),
  secretProviders: [memorySecretProvider()],
}));

// ---------------------------------------------------------------------------
// Echo server — captures the inbound request and returns a configurable
// response. Use `respondWith` to override; default is 200 JSON `{ ok: true }`.
// ---------------------------------------------------------------------------

export interface CapturedRequest {
  method: string;
  /** Full request URL including query string as the server saw it. */
  url: string;
  /** Path portion only, e.g. `/users/42`. */
  path: string;
  /** Query string portion only, e.g. `?tag=a&tag=b`. */
  search: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  bodyBuffer: Buffer;
  contentType: string;
}

export interface EchoResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Buffer | null;
}

export interface EchoServer {
  baseUrl: string;
  captured: CapturedRequest;
  /** Replace the next-and-subsequent responses returned by the server. */
  respondWith: (response: EchoResponse) => void;
  close: () => void;
}

const defaultCaptured = (): CapturedRequest => ({
  method: "",
  url: "",
  path: "",
  search: "",
  headers: {},
  body: "",
  bodyBuffer: Buffer.alloc(0),
  contentType: "",
});

export const startEchoServer = () =>
  Effect.acquireRelease(
    Effect.async<EchoServer>((resume) => {
      const captured = defaultCaptured();
      let response: EchoResponse = {
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ok: true }),
      };

      const server = createServer((req: IncomingMessage, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          const buf = Buffer.concat(chunks);
          const [path, search = ""] = (req.url ?? "").split("?", 2) as [
            string,
            string?,
          ];
          captured.method = req.method ?? "";
          captured.url = req.url ?? "";
          captured.path = path;
          captured.search = search ? `?${search}` : "";
          captured.headers = { ...req.headers };
          captured.contentType = (req.headers["content-type"] as string) ?? "";
          captured.bodyBuffer = buf;
          captured.body = buf.toString("utf8");

          const status = response.status ?? 200;
          const headers = response.headers ?? {};
          res.writeHead(status, headers);
          if (response.body === null || response.body === undefined) {
            res.end();
          } else if (Buffer.isBuffer(response.body)) {
            res.end(response.body);
          } else {
            res.end(response.body);
          }
        });
      });

      server.listen(0, "127.0.0.1", () => {
        const port = (server.address() as AddressInfo).port;
        resume(
          Effect.succeed({
            baseUrl: `http://127.0.0.1:${port}`,
            captured,
            respondWith: (r) => {
              response = r;
            },
            close: () => server.close(),
          }),
        );
      });
    }),
    (s) => Effect.sync(() => s.close()),
  );

// ---------------------------------------------------------------------------
// Minimal spec builder — the compliance tests all stand up tiny specs
// that isolate ONE feature. These helpers spit out a JSON string ready for
// `executor.openapi.addSpec`.
// ---------------------------------------------------------------------------

export interface MinimalOperationInput {
  method: "get" | "post" | "put" | "patch" | "delete";
  path: string;
  operationId: string;
  tags?: readonly string[];
  parameters?: readonly Record<string, unknown>[];
  requestBody?: Record<string, unknown>;
  responses?: Record<string, unknown>;
  security?: readonly Record<string, readonly string[]>[];
}

export interface MinimalSpecInput {
  title?: string;
  version?: string;
  servers?: readonly Record<string, unknown>[];
  operations: readonly MinimalOperationInput[];
  components?: Record<string, unknown>;
  security?: readonly Record<string, readonly string[]>[];
}

export const makeMinimalSpec = (input: MinimalSpecInput): string => {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of input.operations) {
    const pathItem = (paths[op.path] ??= {});
    pathItem[op.method] = {
      operationId: op.operationId,
      ...(op.tags ? { tags: op.tags } : {}),
      ...(op.parameters ? { parameters: op.parameters } : {}),
      ...(op.requestBody ? { requestBody: op.requestBody } : {}),
      ...(op.security ? { security: op.security } : {}),
      responses: op.responses ?? {
        "200": {
          description: "ok",
          content: {
            "application/json": {
              schema: { type: "object", additionalProperties: true },
            },
          },
        },
      },
    };
  }

  return JSON.stringify({
    openapi: "3.0.3",
    info: { title: input.title ?? "Compliance", version: input.version ?? "1.0.0" },
    ...(input.servers ? { servers: input.servers } : {}),
    ...(input.security ? { security: input.security } : {}),
    paths,
    ...(input.components ? { components: input.components } : {}),
  });
};

// ---------------------------------------------------------------------------
// Tiny conveniences used across tests — pulling a captured cookie jar or
// checking the raw request line.
// ---------------------------------------------------------------------------

export const getHeader = (
  captured: CapturedRequest,
  name: string,
): string | undefined => {
  const v = captured.headers[name.toLowerCase()];
  if (Array.isArray(v)) return v.join(", ");
  return v ?? undefined;
};

/** Parse a `Cookie:` header into an ordered array of [name, value]. */
export const parseCookies = (
  cookieHeader: string | undefined,
): Array<readonly [string, string]> => {
  if (!cookieHeader) return [];
  return cookieHeader.split(/;\s*/).flatMap((pair) => {
    const eq = pair.indexOf("=");
    if (eq < 0) return [];
    return [[pair.slice(0, eq), pair.slice(eq + 1)] as const];
  });
};
