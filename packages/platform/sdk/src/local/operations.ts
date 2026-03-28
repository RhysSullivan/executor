import * as Effect from "effect/Effect";

import {
  InstallationStore,
} from "../runtime/scope/storage";
import {
  operationErrors,
} from "../runtime/policy/operation-errors";

const localOps = {
  installation: operationErrors("local.installation.get"),
} as const;

export const getLocalInstallation = () =>
  Effect.gen(function* () {
    const installationStore = yield* InstallationStore;
    return yield* installationStore.load().pipe(
      Effect.mapError((error) =>
        localOps.installation.unknownStorage(
          error,
          "Failed loading local installation",
        ),
      ),
    );
  });
