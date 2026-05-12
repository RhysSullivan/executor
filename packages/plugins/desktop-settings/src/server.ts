/**
 * @executor-js/plugin-desktop-settings/server
 *
 * Zero-server-state plugin. The Desktop Settings panel reads and writes
 * its configuration via Electron IPC (`window.executor.*`), not through
 * the executor server. This file exists so the host can register the
 * plugin's `packageName` and the vite plugin can find the `./client`
 * bundle — that's the entire server contribution.
 */

import { definePlugin } from "@executor-js/sdk/core";

export const desktopSettingsPlugin = definePlugin(() => ({
  id: "desktop-settings" as const,
  packageName: "@executor-js/plugin-desktop-settings",
  storage: () => ({}),
}));
