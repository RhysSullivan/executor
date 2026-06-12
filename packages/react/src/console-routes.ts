import { index, route } from "@tanstack/virtual-file-routes";
import type { VirtualRouteNode } from "@tanstack/virtual-file-routes";

// ---------------------------------------------------------------------------
// The shared console route contract. This package's pages and shell link to
// these paths (`Link to="/integrations/$namespace"` etc.), so every app that
// renders the shared console MUST register them — historically each app
// re-declared the same route files by hand and they drifted (host-cloudflare
// shipped `/sources/*` while the shell linked `/integrations/*`).
//
// `consoleRoutes()` makes the contract executable: app vite configs compose it
// into their TanStack `virtualRouteConfig`, mounting the canonical route files
// that live in `src/routes/` next to the pages they bind. Apps keep their own
// `__root.tsx` (the auth shell is what genuinely differs) and add app-specific
// routes alongside. An app with an intentionally different surface for one of
// these paths excludes it here and registers its own file instead.
// ---------------------------------------------------------------------------

export const CONSOLE_ROUTE_PATHS = [
  "/",
  "/integrations/$namespace",
  "/integrations/add/$pluginKey",
  "/policies",
  "/secrets",
  "/tools",
  "/resume/$executionId",
  "/plugins/$pluginId/$",
] as const;

export type ConsoleRoutePath = (typeof CONSOLE_ROUTE_PATHS)[number];

export interface ConsoleRoutesOptions {
  /** Path from the app's `routesDirectory` to this package's `src/routes`. */
  readonly dir: string;
  /** Shared paths this app replaces with its own route file (or omits). */
  readonly exclude?: ReadonlyArray<ConsoleRoutePath>;
}

export const consoleRoutes = (options: ConsoleRoutesOptions): Array<VirtualRouteNode> => {
  const excluded = new Set(options.exclude ?? []);
  const file = (name: string): string => `${options.dir}/${name}`;
  const entries: ReadonlyArray<readonly [ConsoleRoutePath, VirtualRouteNode]> = [
    ["/", index(file("index.tsx"))],
    [
      "/integrations/$namespace",
      route("/integrations/$namespace", file("integrations.$namespace.tsx")),
    ],
    [
      "/integrations/add/$pluginKey",
      route("/integrations/add/$pluginKey", file("integrations.add.$pluginKey.tsx")),
    ],
    ["/policies", route("/policies", file("policies.tsx"))],
    ["/secrets", route("/secrets", file("secrets.tsx"))],
    ["/tools", route("/tools", file("tools.tsx"))],
    ["/resume/$executionId", route("/resume/$executionId", file("resume.$executionId.tsx"))],
    ["/plugins/$pluginId/$", route("/plugins/$pluginId/$", file("plugins.$pluginId.$.tsx"))],
  ];
  return entries.filter(([path]) => !excluded.has(path)).map(([, node]) => node);
};
