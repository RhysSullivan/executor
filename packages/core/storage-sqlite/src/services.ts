import { Effect } from "effect";
import {
  makeInMemorySourceRegistry,
  makeToolRegistry,
  makeSecretManager,
  makePolicyEngine,
  makePluginKvFactory,
  type Scope,
  type SecretProvider,
} from "@executor/storage";

import type { DrizzleDb } from "./db";
import {
  makeSqliteToolStore,
  makeSqliteSecretStore,
  makeSqlitePolicyStore,
  makeSqlitePluginKvStore,
} from "./stores";

export interface SqliteServicesOptions {
  readonly scope: Scope;
  readonly encryptionKey: string;
  readonly secretProviders?: readonly SecretProvider[];
}

export const makeSqliteServices = (db: DrizzleDb, options: SqliteServicesOptions) =>
  Effect.gen(function* () {
    const toolStore = makeSqliteToolStore(db);
    const secretStore = makeSqliteSecretStore(db);
    const policyStore = makeSqlitePolicyStore(db);
    const pluginKvStore = makeSqlitePluginKvStore(db);

    return {
      tools: makeToolRegistry(toolStore, options.scope),
      sources: makeInMemorySourceRegistry(),
      secrets: makeSecretManager(secretStore, options.scope, {
        encryptionKey: options.encryptionKey,
        providers: options.secretProviders ?? [],
      }),
      policies: makePolicyEngine(policyStore, options.scope),
      pluginKv: makePluginKvFactory(pluginKvStore, options.scope),
    };
  });
