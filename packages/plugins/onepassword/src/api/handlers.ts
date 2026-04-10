import { HttpApiBuilder } from "@effect/platform";
import { Context, Effect } from "effect";

import { addGroup } from "@executor/api";
import type { OnePasswordExtension } from "../sdk/plugin";
import { OnePasswordGroup } from "./group";

// ---------------------------------------------------------------------------
// Service tag — the server provides the 1Password extension
// ---------------------------------------------------------------------------

export class OnePasswordExtensionService extends Context.Tag("OnePasswordExtensionService")<
  OnePasswordExtensionService,
  OnePasswordExtension
>() {}

// ---------------------------------------------------------------------------
// Composed API — core + onepassword group
// ---------------------------------------------------------------------------

const ExecutorApiWithOnePassword = addGroup(OnePasswordGroup);

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export const OnePasswordHandlers = HttpApiBuilder.group(
  ExecutorApiWithOnePassword,
  "onepassword",
  (handlers) =>
    handlers
      .handle("getConfig", () =>
        Effect.gen(function* () {
          const ext = yield* OnePasswordExtensionService;
          return yield* ext.getConfig();
        }).pipe(Effect.orDie),
      )
      .handle("configure", ({ payload }) =>
        Effect.gen(function* () {
          const ext = yield* OnePasswordExtensionService;
          yield* ext.configure(payload);
        }).pipe(Effect.orDie),
      )
      .handle("removeConfig", () =>
        Effect.gen(function* () {
          const ext = yield* OnePasswordExtensionService;
          yield* ext.removeConfig();
        }).pipe(Effect.orDie),
      )
      .handle("status", () =>
        Effect.gen(function* () {
          const ext = yield* OnePasswordExtensionService;
          return yield* ext.status();
        }).pipe(Effect.orDie),
      )
      .handle("listVaults", ({ urlParams }) =>
        Effect.gen(function* () {
          const ext = yield* OnePasswordExtensionService;
          const auth =
            urlParams.authKind === "desktop-app"
              ? { kind: "desktop-app" as const, accountName: urlParams.account }
              : { kind: "service-account" as const, tokenSecretId: urlParams.account };
          const vaults = yield* ext.listVaults(auth);
          return { vaults: [...vaults] };
        }).pipe(Effect.orDie),
      ),
);
