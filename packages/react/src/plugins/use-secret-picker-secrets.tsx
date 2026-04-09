import { useAtomValue, Result } from "@effect-atom/atom-react";

import { secretsAtom } from "../api/atoms";
import { useScope } from "../api/scope-context";
import type { SecretPickerSecret } from "./secret-picker";

export function useSecretPickerSecrets(): readonly SecretPickerSecret[] {
  const scopeId = useScope();
  const secrets = useAtomValue(secretsAtom(scopeId));

  return Result.match(secrets, {
    onInitial: () => [] as SecretPickerSecret[],
    onFailure: () => [] as SecretPickerSecret[],
    onSuccess: ({ value }) =>
      value.map((secret) => ({
        id: secret.id,
        name: secret.name,
        provider: secret.provider ? String(secret.provider) : undefined,
      })),
  });
}
