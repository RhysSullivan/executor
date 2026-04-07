import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

type HotBackend = {
  readonly api: {
    readonly handler: (request: Request) => Promise<Response>;
    readonly dispose: () => Promise<void>;
  };
  readonly mcp: {
    readonly handleRequest: (request: Request) => Promise<Response>;
    readonly close: () => Promise<void>;
  };
  readonly dispose: () => Promise<void>;
};

const DEV_BACKEND_MODULE_ID = `/@fs/${resolve(
  process.cwd(),
  "src/server/dev-backend.ts",
).replace(/\\/g, "/")}`;

// Build a Web Request from a Node IncomingMessage
const toWebRequest = async (
  req: import("http").IncomingMessage,
): Promise<Request> => {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, value);
    }
  }

  const host = req.headers.host ?? "localhost";
  const url = `http://${host}${req.url}`;

  return new Request(
    url,
    {
      method: req.method,
      headers,
      body:
        req.method !== "GET" && req.method !== "HEAD"
          ? (await new Promise<Buffer>((resolve) => {
              const chunks: Buffer[] = [];
              req.on("data", (c: Buffer) => chunks.push(c));
              req.on("end", () => resolve(Buffer.concat(chunks)));
            }) as unknown as BodyInit)
          : undefined,
      duplex: "half" as const,
    } as RequestInit & { duplex: "half" },
  );
};

// Pipe a Web Response back to a Node ServerResponse, streaming if needed
const sendWebResponse = async (
  webRes: Response,
  nodeRes: import("http").ServerResponse,
) => {
  nodeRes.statusCode = webRes.status;
  webRes.headers.forEach((value, key) => nodeRes.setHeader(key, value));

  if (!webRes.body) {
    nodeRes.end();
    return;
  }

  const reader = webRes.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      nodeRes.write(value);
    }
  } finally {
    nodeRes.end();
  }
};

const rootPackage = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string; homepage?: string; repository?: string | { url?: string } };

const cliPackage = JSON.parse(
  readFileSync(new URL("../cli/package.json", import.meta.url), "utf8"),
) as { version?: string };

const repositoryUrl =
  typeof rootPackage.repository === "string"
    ? rootPackage.repository
    : rootPackage.repository?.url;

const EXECUTOR_VERSION = cliPackage.version ?? rootPackage.version;
const EXECUTOR_GITHUB_URL = (rootPackage.homepage ?? repositoryUrl ?? "https://github.com/RhysSullivan/executor")
  .replace(/^git\+/, "")
  .replace(/\.git$/, "");

export default defineConfig({
  define: {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(EXECUTOR_VERSION),
    "import.meta.env.VITE_GITHUB_URL": JSON.stringify(EXECUTOR_GITHUB_URL),
  },
  resolve: {
    dedupe: ["react", "react-dom"],
  },
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "executor-api",
      configureServer(server) {
        let backendPromise: Promise<HotBackend> | null = null;
        let reloadPromise: Promise<void> | null = null;

        const loadBackend = () =>
          server
            .ssrLoadModule(DEV_BACKEND_MODULE_ID)
            .then((mod) => mod.createHotBackend() as Promise<HotBackend>);

        const getBackend = () => {
          if (!backendPromise) {
            backendPromise = loadBackend();
          }
          return backendPromise;
        };

        const shouldReloadBackend = (file: string) =>
          /\.(ts|tsx)$/.test(file) &&
          !file.includes("/src/web/") &&
          (
            file.includes("/src/server/") ||
            file.includes("/packages/core/") ||
            file.includes("/packages/plugins/") ||
            file.includes("/packages/hosts/")
          );

        server.httpServer?.once("close", () => {
          const pending = backendPromise;
          backendPromise = null;
          void pending?.then((backend) => backend.dispose()).catch(() => undefined);
        });

        server.watcher.on("change", (file) => {
          if (!shouldReloadBackend(file) || reloadPromise) {
            return;
          }

          reloadPromise = (async () => {
            server.config.logger.info(`[executor-api] hot reloading backend: ${file}`);

            const previous = await getBackend().catch(() => null);

            server.moduleGraph.invalidateAll();
            backendPromise = loadBackend();

            await backendPromise;
            await previous?.dispose().catch(() => undefined);

            server.ws.send({
              type: "custom",
              event: "executor:backend-updated",
              data: { file },
            });
          })()
            .catch((error) => {
              server.config.logger.error(
                `[executor-api] backend reload failed: ${error instanceof Error ? error.message : String(error)}`,
              );
            })
            .finally(() => {
              reloadPromise = null;
            });
        });

        // Host-header allowlist — blocks DNS rebinding attacks
        const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

        server.middlewares.use(async (req, res, next) => {
          const url = req.url ?? "/";

          const isApi =
            url.startsWith("/v1/") ||
            url.startsWith("/docs") ||
            url === "/openapi.json";
          const isMcp = url.startsWith("/mcp");

          if (!isApi && !isMcp) return next();

          // Validate host header to prevent DNS rebinding
          const host = req.headers.host;
          if (host) {
            const hostname = host.replace(/:\d+$/, "");
            if (!ALLOWED_HOSTS.has(hostname)) {
              res.statusCode = 403;
              res.end("Forbidden");
              return;
            }
          }

          const backend = await getBackend();
          const request = await toWebRequest(req);

          const response = isMcp
            ? await backend.mcp.handleRequest(request)
            : await backend.api.handler(request);

          await sendWebResponse(response, res);
        });
      },
    },
  ],
});
