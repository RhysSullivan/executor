import type {
  LocalConfigSource,
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

export const deriveLocalSourceId = (
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

export const configSourceBaseFromLocalSource = (input: {
  source: Source;
}): Omit<LocalConfigSource, "kind" | "config" | "connection" | "binding"> => ({
  ...(trimOrNull(input.source.name) !== trimOrNull(input.source.id)
    ? { name: input.source.name }
    : {}),
  ...(trimOrNull(input.source.namespace) !== trimOrNull(input.source.id)
    ? { namespace: input.source.namespace ?? undefined }
    : {}),
  ...(input.source.enabled === false ? { enabled: false } : {}),
});

export const configSourceFromLocalSource = (input: {
  source: Source;
  existingConfig?: LocalConfigSource | null;
}): LocalConfigSource => {
  return {
    ...configSourceBaseFromLocalSource({
      source: input.source,
    }),
    kind: input.source.kind as LocalConfigSource["kind"],
    ...(input.existingConfig?.config !== undefined
      ? {
          config: cloneJson(input.existingConfig.config),
        }
      : {}),
    ...(input.existingConfig?.connection !== undefined
      ? {
          connection: cloneJson(input.existingConfig.connection),
        }
      : {}),
    ...(input.existingConfig?.binding !== undefined
      ? {
          binding: cloneJson(input.existingConfig.binding),
        }
      : {}),
  } as LocalConfigSource;
};
