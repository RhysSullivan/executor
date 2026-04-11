import { openApiPlugin as openApiPluginEffect } from "./sdk/plugin";

export type { OpenApiSpecConfig } from "./sdk/plugin";

export type OpenApiPluginOptions = Record<string, never>;

export const openApiPlugin = (_options?: OpenApiPluginOptions) => openApiPluginEffect();
