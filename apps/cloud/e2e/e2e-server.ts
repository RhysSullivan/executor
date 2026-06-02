// ---------------------------------------------------------------------------
// Boots the cloud app's Vite dev server for the Playwright e2e suite — the SAME
// dev stack a developer runs (`bun run dev`), minus 1Password / real WorkOS.
//
// Everything here is a STUB: fake WorkOS creds, a fixed cookie/encryption key,
// and a throwaway PGlite on its own port (so it never collides with a running
// `bun dev`). That's deliberate — what the spec guards (the TanStack Start client
// entry hydrating) is a CLIENT-side module-graph concern that doesn't depend on
// any of these values, so the stub config is sufficient and the harness stays
// runnable in CI with no secrets.
//
// Used by `playwright.config.ts`'s `webServer`. Spawns the dev DB + Vite, wires
// their stdout through, and tears both down on exit.
// ---------------------------------------------------------------------------

import { spawn, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const PORT = process.env.E2E_PORT ?? "4798";
const DB_PORT = process.env.E2E_DB_PORT ?? "5435";
const ORIGIN = `http://127.0.0.1:${PORT}`;

const stubEnv: NodeJS.ProcessEnv = {
  ...process.env,
  // WorkOS — never contacted during the hydration path; just has to be present.
  WORKOS_API_KEY: "sk_e2e_stub",
  WORKOS_CLIENT_ID: "client_e2e_stub",
  WORKOS_COOKIE_PASSWORD: "e2e_cookie_password_0123456789abcdef0123456789abcdef",
  AUTUMN_SECRET_KEY: "am_e2e_stub",
  // 32-byte hex at-rest key (only used lazily on secret writes, not on render).
  ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  // Direct connection to the throwaway PGlite (no Hyperdrive in dev).
  DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${DB_PORT}/postgres`,
  EXECUTOR_DIRECT_DATABASE_URL: "true",
  CLOUDFLARE_INCLUDE_PROCESS_ENV: "true",
  VITE_PUBLIC_SITE_URL: ORIGIN,
  MCP_AUTHKIT_DOMAIN: "https://example.com",
  MCP_RESOURCE_ORIGIN: ORIGIN,
  // Throwaway dev DB on its own port + dir so it never fights a running `bun dev`.
  DEV_DB_PORT: DB_PORT,
  DEV_DB_PATH: resolve(appDir, ".e2e-db"),
};

const children: ChildProcess[] = [];
const start = (cmd: string, args: string[]) => {
  const child = spawn(cmd, args, { cwd: appDir, env: stubEnv, stdio: "inherit" });
  child.on("exit", (code) => {
    // If either process dies, take the whole harness down so Playwright fails fast.
    if (code !== 0 && code !== null) {
      shutdown(code);
    }
  });
  children.push(child);
};

const shutdown = (code = 0) => {
  for (const child of children) child.kill("SIGTERM");
  process.exit(code);
};
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

start("bun", ["run", "scripts/dev-db.ts"]);
start("bunx", ["vite", "dev", "--port", PORT, "--strictPort", "--host", "127.0.0.1"]);
