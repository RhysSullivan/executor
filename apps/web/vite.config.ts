import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createApiHandler } from "@executor/server";

const api = createApiHandler();

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "executor-api",
      configureServer(server) {
        // Forward /v1/* and /docs/* to the Effect API handler
        server.middlewares.use(async (req, res, next) => {
          const url = req.url ?? "/";
          if (
            url.startsWith("/v1/") ||
            url.startsWith("/docs") ||
            url === "/openapi.json"
          ) {
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
            const request = new Request(`http://${host}${url}`, {
              method: req.method,
              headers,
              body:
                req.method !== "GET" && req.method !== "HEAD"
                  ? (await new Promise<Uint8Array>((resolve) => {
                      const chunks: Uint8Array[] = [];
                      req.on("data", (c: Uint8Array) => chunks.push(c));
                      req.on("end", () => {
                        const total = chunks.reduce((n, c) => n + c.length, 0);
                        const buf = new Uint8Array(total);
                        let offset = 0;
                        for (const c of chunks) { buf.set(c, offset); offset += c.length; }
                        resolve(buf);
                      });
                    }) as unknown as BodyInit)
                  : undefined,
            });

            const response = await api.handler(request);

            res.statusCode = response.status;
            response.headers.forEach((value, key) => {
              res.setHeader(key, value);
            });

            const body = await response.arrayBuffer();
            res.end(Buffer.from(body));
            return;
          }
          next();
        });
      },
    },
  ],
});
