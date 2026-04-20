import { useMemo, useState } from "react";

export function slugifyForSecretId(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const normalizeSecretId = (secretId: string): string => secretId.trim();

export function isSecretIdTaken(
  secretId: string,
  existingSecretIds: Iterable<string>,
): boolean {
  const normalizedId = normalizeSecretId(secretId);
  if (!normalizedId) return false;

  for (const existingSecretId of existingSecretIds) {
    if (normalizeSecretId(existingSecretId) === normalizedId) {
      return true;
    }
  }

  return false;
}

export function getUniqueSecretId(
  baseName: string,
  existingSecretIds: Iterable<string>,
  fallbackId = "secret",
): string {
  const baseId = slugifyForSecretId(baseName) || fallbackId;
  if (!baseId) return "";
  if (!isSecretIdTaken(baseId, existingSecretIds)) return baseId;

  let suffix = 2;
  while (isSecretIdTaken(`${baseId}-${suffix}`, existingSecretIds)) {
    suffix += 1;
  }
  return `${baseId}-${suffix}`;
}

export function useUniqueSecretIdInput(options: {
  baseName: string;
  existingSecretIds: readonly string[];
  fallbackId?: string;
}) {
  const { baseName, existingSecretIds, fallbackId = "secret" } = options;
  const [idOverride, setIdOverride] = useState<string | null>(null);

  const suggestedId = useMemo(
    () => getUniqueSecretId(baseName, existingSecretIds, fallbackId),
    [baseName, existingSecretIds, fallbackId],
  );
  const secretId = idOverride ?? suggestedId;
  const duplicateError = useMemo(
    () => (isSecretIdTaken(secretId, existingSecretIds) ? "Secret ID already exists" : null),
    [secretId, existingSecretIds],
  );

  return {
    secretId,
    suggestedId,
    duplicateError,
    hasManualOverride: idOverride !== null,
    setSecretIdOverride: (value: string) => setIdOverride(value),
    resetSecretIdOverride: () => setIdOverride(null),
  };
}
