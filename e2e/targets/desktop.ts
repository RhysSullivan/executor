// The Electron desktop app as a target. Unlike cloud/selfhost there is no
// long-lived instance to point a browser at — each scenario launches its own
// app process (Playwright's electron driver) against a throwaway HOME, so
// the target carries no capabilities and scenarios under e2e/desktop/ drive
// the app themselves. Identity is the local OS user; there is nothing to
// mint.
import { Effect } from "effect";

import type { Target } from "../src/target";

export const desktopTarget = (): Target => ({
  name: "desktop",
  baseUrl: "",
  mcpUrl: "",
  capabilities: new Set(),
  newIdentity: () => Effect.succeed({ label: "desktop-local-user" }),
});
