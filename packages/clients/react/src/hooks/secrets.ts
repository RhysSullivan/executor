import {
  useAtomRefresh,
  useAtomSet,
} from "@effect-atom/atom-react";
import type {
  CreateSecretPayload,
  CreateSecretResult,
  DeleteSecretResult,
  SecretListItem,
  UpdateSecretPayload,
  UpdateSecretResult,
} from "@executor/platform-api";
import * as React from "react";

import { getExecutorApiBaseUrl } from "../core/base-url";
import { getExecutorApiHttpClient } from "../core/http-client";
import { secretsAtom } from "../core/api-atoms";
import { useLoadableAtom } from "../core/loadable";
import { secretsReactivityKey } from "../core/reactivity";
import type { Loadable } from "../core/types";
import { useExecutorMutation } from "./mutations";

export const useSecrets = (): Loadable<ReadonlyArray<SecretListItem>> =>
  useLoadableAtom(secretsAtom(getExecutorApiBaseUrl()));

export const useRefreshSecrets = (): (() => void) =>
  useAtomRefresh(secretsAtom(getExecutorApiBaseUrl()));

export const useCreateSecret = () => {
  const mutate = useAtomSet(
    getExecutorApiHttpClient().mutation("local", "createSecret"),
    { mode: "promise" },
  );

  return useExecutorMutation<CreateSecretPayload, CreateSecretResult>(
    React.useCallback(
      (payload) =>
        mutate({
          payload,
          reactivityKeys: secretsReactivityKey(),
        }),
      [mutate],
    ),
  );
};

export const useUpdateSecret = () => {
  const mutate = useAtomSet(
    getExecutorApiHttpClient().mutation("local", "updateSecret"),
    { mode: "promise" },
  );

  return useExecutorMutation<
    { secretId: string; payload: UpdateSecretPayload },
    UpdateSecretResult
  >(
    React.useCallback(
      (input) =>
        mutate({
          path: { secretId: input.secretId },
          payload: input.payload,
          reactivityKeys: secretsReactivityKey(),
        }),
      [mutate],
    ),
  );
};

export const useDeleteSecret = () => {
  const mutate = useAtomSet(
    getExecutorApiHttpClient().mutation("local", "deleteSecret"),
    { mode: "promise" },
  );

  return useExecutorMutation<string, DeleteSecretResult>(
    React.useCallback(
      (secretId) =>
        mutate({
          path: { secretId },
          reactivityKeys: secretsReactivityKey(),
        }),
      [mutate],
    ),
  );
};
