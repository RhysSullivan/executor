import {
  kvDeleteInputSchema,
  kvDeleteOutputSchema,
  kvGetInputSchema,
  kvGetOutputSchema,
  kvIncrInputSchema,
  kvIncrOutputSchema,
  kvListInputSchema,
  kvListOutputSchema,
  kvSetInputSchema,
  kvSetOutputSchema,
} from "../storage_tool_contracts/kv";
import {
  assertFiniteNumber,
  resolveStorageProviderForPayload,
  touchInstance,
  type StorageToolHandlerArgs,
} from "./context";

export async function runKvHandler(args: StorageToolHandlerArgs): Promise<unknown | undefined> {
  const {
    ctx,
    task,
    payload,
    normalizedToolPath,
  } = args;

  if (normalizedToolPath === "kv.get") {
    const parsed = kvGetInputSchema.parse(payload);
    const { instance, provider } = await resolveStorageProviderForPayload(ctx, task, payload);
    const value = await provider.kvGet(instance, parsed.key);
    await touchInstance(ctx, task, instance, provider, false);
    return kvGetOutputSchema.parse({
      instanceId: instance.id,
      key: parsed.key,
      found: value !== undefined,
      ...(value !== undefined ? { value } : {}),
    });
  }

  if (normalizedToolPath === "kv.set") {
    const parsed = kvSetInputSchema.parse(payload);
    const { instance, provider } = await resolveStorageProviderForPayload(ctx, task, payload);
    await provider.kvSet(instance, parsed.key, parsed.value);
    await touchInstance(ctx, task, instance, provider, true);
    return kvSetOutputSchema.parse({
      instanceId: instance.id,
      key: parsed.key,
      ok: true,
    });
  }

  if (normalizedToolPath === "kv.list") {
    const parsed = kvListInputSchema.parse(payload);
    const { instance, provider } = await resolveStorageProviderForPayload(ctx, task, payload);
    const limit = Math.max(1, Math.min(500, Math.floor(parsed.limit ?? 100)));
    const items = await provider.kvList(instance, parsed.prefix ?? "", limit);
    await touchInstance(ctx, task, instance, provider, false);
    return kvListOutputSchema.parse({
      instanceId: instance.id,
      items,
      total: items.length,
    });
  }

  if (normalizedToolPath === "kv.delete") {
    const parsed = kvDeleteInputSchema.parse(payload);
    const { instance, provider } = await resolveStorageProviderForPayload(ctx, task, payload);
    await provider.kvDelete(instance, parsed.key);
    await touchInstance(ctx, task, instance, provider, true);
    return kvDeleteOutputSchema.parse({
      instanceId: instance.id,
      key: parsed.key,
      ok: true,
    });
  }

  if (normalizedToolPath === "kv.incr" || normalizedToolPath === "kv.decr") {
    const parsed = kvIncrInputSchema.parse(payload);
    const { instance, provider } = await resolveStorageProviderForPayload(ctx, task, payload);

    const existing = await provider.kvGet(instance, parsed.key);
    const initial = assertFiniteNumber(parsed.initial ?? 0, "initial");
    const previous = existing === undefined
      ? initial
      : assertFiniteNumber(existing, `kv value at '${parsed.key}'`);

    const rawBy = assertFiniteNumber(parsed.by ?? 1, "by");
    const by = normalizedToolPath === "kv.decr" ? -Math.abs(rawBy) : rawBy;
    const value = previous + by;

    await provider.kvSet(instance, parsed.key, value);
    await touchInstance(ctx, task, instance, provider, true);

    return kvIncrOutputSchema.parse({
      instanceId: instance.id,
      key: parsed.key,
      by,
      previous,
      value,
    });
  }

  return undefined;
}
