import {
  useAtomRefresh,
} from "@effect-atom/atom-react";
import type {
  InstanceConfig,
  LocalInstallation,
} from "@executor/platform-api";

import { getExecutorApiBaseUrl } from "../core/base-url";
import { instanceConfigAtom, localInstallationAtom } from "../core/api-atoms";
import { useLoadableAtom } from "../core/loadable";
import type { Loadable } from "../core/types";

export const useLocalInstallation = (): Loadable<LocalInstallation> =>
  useLoadableAtom(localInstallationAtom(getExecutorApiBaseUrl()));

export const useInstanceConfig = (): Loadable<InstanceConfig> =>
  useLoadableAtom(instanceConfigAtom(getExecutorApiBaseUrl()));

export const useRefreshLocalInstallation = (): (() => void) =>
  useAtomRefresh(localInstallationAtom(getExecutorApiBaseUrl()));
