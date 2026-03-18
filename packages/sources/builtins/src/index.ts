import type { SourceAdapter } from "@executor/source-core";
import { googleDiscoverySourceAdapter } from "@executor/source-google-discovery";
import { graphqlSourceAdapter } from "@executor/source-graphql";
import { mcpSourceAdapter } from "@executor/source-mcp";
import { openApiSourceAdapter } from "@executor/source-openapi";

export const externalSourceAdapters = [
  openApiSourceAdapter,
  graphqlSourceAdapter,
  googleDiscoverySourceAdapter,
  mcpSourceAdapter,
] as const satisfies readonly SourceAdapter[];
