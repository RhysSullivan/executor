import { launchdPlugin as launchdPluginEffect } from "./index";

export type { LaunchdPluginConfig } from "./index";

export const launchdPlugin = (config?: {
  readonly label?: string;
  readonly plistPath?: string;
  readonly logPath?: string;
  readonly defaultPort?: number;
}) => launchdPluginEffect(config);
