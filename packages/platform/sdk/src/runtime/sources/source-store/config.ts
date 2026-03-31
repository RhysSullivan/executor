import type {
  ExecutorScopeConfigSource,
  Source,
  SourceId,
} from "#schema";
import {
  SourceIdSchema,
} from "#schema";

import {
  slugify,
} from "../slug";

export const trimOrNull = (value: string | null | undefined): string | null => {
  if (value == null) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const cloneJson = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value)) as T;

export const deriveScopeConfigSourceId = (
  source: Pick<Source, "namespace" | "name">,
  used: ReadonlySet<string>,
): SourceId => {
  const base = trimOrNull(source.namespace) ?? trimOrNull(source.name) ?? "source";
  const slugBase = slugify(base) || "source";
  let candidate = slugBase;
  let counter = 2;
  while (used.has(candidate)) {
    candidate = `${slugBase}-${counter}`;
    counter += 1;
  }
  return SourceIdSchema.make(candidate);
};

export const scopeConfigSourceBaseFromSource = (input: {
  source: Source;
}): Omit<ExecutorScopeConfigSource, "kind" | "config"> => ({
  ...(trimOrNull(input.source.name) !== trimOrNull(input.source.id)
    ? { name: input.source.name }
    : {}),
  ...(trimOrNull(input.source.namespace) !== trimOrNull(input.source.id)
    ? { namespace: input.source.namespace ?? undefined }
    : {}),
  ...(input.source.iconUrl?.trim()
    ? { iconUrl: input.source.iconUrl.trim() }
    : {}),
  ...(input.source.enabled === false ? { enabled: false } : {}),
});

export const scopeConfigSourceFromSource = (input: {
  source: Source;
  existingConfig?: ExecutorScopeConfigSource | null;
}): ExecutorScopeConfigSource => {
  return {
    ...scopeConfigSourceBaseFromSource({
      source: input.source,
    }),
    kind: input.source.kind as ExecutorScopeConfigSource["kind"],
    ...(input.existingConfig?.config !== undefined
      ? {
          config: cloneJson(input.existingConfig.config),
        }
      : {}),
  } as ExecutorScopeConfigSource;
};
