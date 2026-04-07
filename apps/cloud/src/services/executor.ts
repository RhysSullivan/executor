// ---------------------------------------------------------------------------
// Cloud executor — stateless, per-request, from Postgres
// ---------------------------------------------------------------------------

import { Effect } from "effect";

import { createExecutor } from "@executor/sdk";
import type { DrizzleDb } from "@executor/storage-postgres";
import { makePgConfig, makePgKv } from "@executor/storage-postgres";
import {
  openApiPlugin,
  makeKvOperationStore,
} from "@executor/plugin-openapi";
import {
  mcpPlugin,
  makeKvBindingStore,
} from "@executor/plugin-mcp";
import {
  googleDiscoveryPlugin,
  makeKvBindingStore as makeKvGoogleDiscoveryBindingStore,
} from "@executor/plugin-google-discovery";
import {
  graphqlPlugin,
  makeKvOperationStore as makeKvGraphqlOperationStore,
} from "@executor/plugin-graphql";

// ---------------------------------------------------------------------------
// Create a fresh executor for a team (stateless, per-request)
// ---------------------------------------------------------------------------

export const createTeamExecutor = (
  db: DrizzleDb,
  teamId: string,
  teamName: string,
  encryptionKey: string,
) =>
  Effect.gen(function* () {
    const kv = makePgKv(db, teamId);
    const config = makePgConfig(db, {
      teamId,
      teamName,
      encryptionKey,
      plugins: [
        openApiPlugin({
          operationStore: makeKvOperationStore(kv, "openapi"),
        }),
        mcpPlugin({
          bindingStore: makeKvBindingStore(kv, "mcp"),
        }),
        googleDiscoveryPlugin({
          bindingStore: makeKvGoogleDiscoveryBindingStore(kv, "google-discovery"),
        }),
        graphqlPlugin({
          operationStore: makeKvGraphqlOperationStore(kv, "graphql"),
        }),
      ] as const,
    });

    return yield* createExecutor(config);
  });
