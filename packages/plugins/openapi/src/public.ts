import type { Plugin } from "@executor/sdk";
import {
  openApiPlugin as _openApiPlugin,
  type OpenApiSpecConfig,
} from "./sdk/plugin";

export type { OpenApiSpecConfig } from "./sdk/plugin";

export interface OpenApiExtension {
  readonly addSpec: (
    config: OpenApiSpecConfig,
  ) => Promise<{ readonly toolCount: number }>;
  readonly removeSpec: (namespace: string) => Promise<void>;
}

export const openApiPlugin: (options?: {}) => Plugin<"openapi", OpenApiExtension> =
  _openApiPlugin as any;
