import { Effect } from "effect";
import { ScopeId, Scope, type SecretProvider } from "@executor/storage";
import { makeInMemorySqliteServices } from "../index";

export interface InMemoryConfigOptions {
  readonly cwd?: string;
  readonly scopeId?: string;
  readonly encryptionKey?: string;
  readonly secretProviders?: readonly SecretProvider[];
}

export const makeInMemoryConfig = (options?: InMemoryConfigOptions) =>
  Effect.gen(function* () {
    const cwd = options?.cwd ?? "/memory";
    const scope = new Scope({
      id: ScopeId.make(options?.scopeId ?? "memory-scope"),
      name: cwd,
      createdAt: new Date(),
    });
    const services = yield* makeInMemorySqliteServices({
      scope,
      encryptionKey: options?.encryptionKey ?? "memory-default-key",
      secretProviders: options?.secretProviders,
    });
    return { scope, ...services };
  });

export { makeInMemorySqliteServices } from "../index";
