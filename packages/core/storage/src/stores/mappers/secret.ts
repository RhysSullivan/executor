import { Option } from "effect";

import { SecretId, ScopeId } from "../../ids";
import { SecretRef } from "../../secrets";
import type { SecretRow } from "../secret-store";

// ---------------------------------------------------------------------------
// Secret mappers
// ---------------------------------------------------------------------------

const STORAGE_PROVIDER_KEY = "storage-encrypted";

export const rowToSecretRef = (row: SecretRow, scopeId: ScopeId): SecretRef =>
  new SecretRef({
    id: SecretId.make(row.id),
    scopeId,
    name: row.name,
    provider: Option.some(row.provider ?? STORAGE_PROVIDER_KEY),
    purpose: row.purpose ?? undefined,
    createdAt: row.createdAt,
  });
