import { tmpdir } from "node:os";

import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import {
  describe,
  expect,
  it,
} from "vitest";
import {
  SecretMaterialIdSchema,
} from "@executor/platform-sdk/schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  resolveLocalWorkspaceContext,
} from "./config";
import {
  createLocalExecutorStatePersistence,
} from "./executor-state-store";
import {
  LOCAL_SECRET_PROVIDER_ID,
  createDefaultSecretMaterialStorer,
  createDefaultSecretMaterialUpdater,
} from "./secret-material-providers";

const makePersistence = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const workspaceRoot = yield* fs.makeTempDirectory({
    directory: tmpdir(),
    prefix: "executor-secret-expiry-",
  });
  const context = yield* resolveLocalWorkspaceContext({
    workspaceRoot,
  });

  return createLocalExecutorStatePersistence(context, fs);
}).pipe(Effect.provide(NodeFileSystem.layer));

describe("secret material providers", () => {
  it("stores and updates secret expiration metadata", async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const persistence = yield* makePersistence;
      const storeSecret = createDefaultSecretMaterialStorer({
        executorState: persistence.executorState,
      });
      const updateSecret = createDefaultSecretMaterialUpdater({
        executorState: persistence.executorState,
      });

      const createdRef = yield* storeSecret({
        providerId: LOCAL_SECRET_PROVIDER_ID,
        purpose: "oauth_access_token",
        value: "access-token",
        name: "Access Token",
        expiresAt: 1_700_000_000_000,
      });

      const created = yield* persistence.executorState.secretMaterials.getById(
        SecretMaterialIdSchema.make(createdRef.handle),
      );
      expect(Option.isSome(created)).toBe(true);
      if (Option.isSome(created)) {
        expect(created.value.expiresAt).toBe(1_700_000_000_000);
      }

      const updated = yield* updateSecret({
        ref: createdRef,
        value: "access-token-rotated",
        expiresAt: 1_800_000_000_000,
      });
      expect(updated.expiresAt).toBe(1_800_000_000_000);

      const reloaded = yield* persistence.executorState.secretMaterials.getById(
        SecretMaterialIdSchema.make(createdRef.handle),
      );
      expect(Option.isSome(reloaded)).toBe(true);
      if (Option.isSome(reloaded)) {
        expect(reloaded.value.expiresAt).toBe(1_800_000_000_000);
      }

      const listed = yield* persistence.executorState.secretMaterials.listAll();
      expect(listed).toEqual([
        expect.objectContaining({
          id: createdRef.handle,
          expiresAt: 1_800_000_000_000,
          purpose: "oauth_access_token",
        }),
      ]);
    }));
  });
});
