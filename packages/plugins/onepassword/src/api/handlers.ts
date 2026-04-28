import { HttpApiBuilder } from "@effect/platform";
import { Context, Effect } from "effect";

import { addGroup, capture } from "@executor/api";
import type { OnePasswordExtension } from "../sdk/plugin";
import { OnePasswordGroup } from "./group";

// ---------------------------------------------------------------------------
// Service tag
//
// Holds the `Captured` shape — every method's `StorageFailure` channel has
// been swapped for `InternalError({ traceId })`. The host provides an
// already-wrapped extension via
// `Layer.succeed(OnePasswordExtensionService, withCapture(executor).onepassword)`.
// Handlers see `InternalError` in the error union, which matches
// `.addError(InternalError)` on the group — no per-handler translation.
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
//
// Each handler is exactly: yield the extension service, call the method,
// return. Plugin SDK errors flow through the typed channel and are
// schema-encoded (OnePasswordError -> 502) by HttpApi. Defects bubble up
// and are captured + downgraded to `InternalError(traceId)` by the
// observability middleware.
// ---------------------------------------------------------------------------

export const OnePasswordHandlers = HttpApiBuilder.group(
  ExecutorApiWithOnePassword,
  "onepassword",
  (handlers) =>
    handlers
      .handle("getConfig", () =>
        capture(Effect.gen(function* () {
          const ext = yield* OnePasswordExtensionService;
          return yield* ext.getConfig();
        })),
      )
      .handle("configure", ({ payload }) =>
        capture(Effect.gen(function* () {
          const ext = yield* OnePasswordExtensionService;
          yield* ext.configure(payload);
        })),
      )
      .handle("removeConfig", () =>
        capture(Effect.gen(function* () {
          const ext = yield* OnePasswordExtensionService;
          yield* ext.removeConfig();
        })),
      )
      .handle("status", () =>
        capture(Effect.gen(function* () {
          const ext = yield* OnePasswordExtensionService;
          return yield* ext.status();
        })),
      )
      .handle("listVaults", ({ urlParams }) =>
        capture(Effect.gen(function* () {
          const ext = yield* OnePasswordExtensionService;
          const auth =
            urlParams.authKind === "desktop-app"
              ? { kind: "desktop-app" as const, accountName: urlParams.account }
              : { kind: "service-account" as const, tokenSecretId: urlParams.account };
          const vaults = yield* ext.listVaults(auth);
          return { vaults: [...vaults] };
        })),
      ),
);
