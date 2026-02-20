import type { StorageEncoding } from "../storage_provider";
import {
  fsMkdirInputSchema,
  fsMkdirOutputSchema,
  fsReadInputSchema,
  fsReadOutputSchema,
  fsReaddirInputSchema,
  fsReaddirOutputSchema,
  fsRemoveInputSchema,
  fsRemoveOutputSchema,
  fsStatInputSchema,
  fsStatOutputSchema,
  fsWriteInputSchema,
  fsWriteOutputSchema,
} from "../storage_tool_contracts/fs";
import {
  resolveStorageProviderForPayload,
  touchInstance,
  type StorageToolHandlerArgs,
} from "./context";

export async function runFsHandler(args: StorageToolHandlerArgs): Promise<unknown | undefined> {
  const {
    ctx,
    task,
    payload,
    normalizedToolPath,
  } = args;

  if (normalizedToolPath === "fs.read") {
    const parsed = fsReadInputSchema.parse(payload);
    const { instance, provider } = await resolveStorageProviderForPayload(ctx, task, payload);
    const encoding = parsed.encoding ?? "utf8";
    const file = await provider.readFile(instance, parsed.path, encoding as StorageEncoding);
    await touchInstance(ctx, task, instance, provider, false);
    return fsReadOutputSchema.parse({
      instanceId: instance.id,
      path: parsed.path,
      encoding,
      content: file.content,
      bytes: file.bytes,
    });
  }

  if (normalizedToolPath === "fs.write") {
    const parsed = fsWriteInputSchema.parse(payload);
    const { instance, provider } = await resolveStorageProviderForPayload(ctx, task, payload);
    const encoding = parsed.encoding ?? "utf8";
    const result = await provider.writeFile(instance, parsed.path, parsed.content, encoding as StorageEncoding);
    await touchInstance(ctx, task, instance, provider, true);
    return fsWriteOutputSchema.parse({
      instanceId: instance.id,
      path: parsed.path,
      bytesWritten: result.bytesWritten,
    });
  }

  if (normalizedToolPath === "fs.readdir") {
    const parsed = fsReaddirInputSchema.parse(payload);
    const { instance, provider } = await resolveStorageProviderForPayload(ctx, task, payload);
    const path = parsed.path ?? "/";
    const entries = await provider.readdir(instance, path);
    await touchInstance(ctx, task, instance, provider, false);
    return fsReaddirOutputSchema.parse({
      instanceId: instance.id,
      path,
      entries,
    });
  }

  if (normalizedToolPath === "fs.stat") {
    const parsed = fsStatInputSchema.parse(payload);
    const { instance, provider } = await resolveStorageProviderForPayload(ctx, task, payload);
    const stat = await provider.stat(instance, parsed.path);
    await touchInstance(ctx, task, instance, provider, false);
    return fsStatOutputSchema.parse({
      instanceId: instance.id,
      path: parsed.path,
      ...stat,
    });
  }

  if (normalizedToolPath === "fs.mkdir") {
    const parsed = fsMkdirInputSchema.parse(payload);
    const { instance, provider } = await resolveStorageProviderForPayload(ctx, task, payload);
    await provider.mkdir(instance, parsed.path);
    await touchInstance(ctx, task, instance, provider, true);
    return fsMkdirOutputSchema.parse({
      instanceId: instance.id,
      path: parsed.path,
      ok: true,
    });
  }

  if (normalizedToolPath === "fs.remove") {
    const parsed = fsRemoveInputSchema.parse(payload);
    const { instance, provider } = await resolveStorageProviderForPayload(ctx, task, payload);
    await provider.remove(instance, parsed.path, {
      recursive: parsed.recursive,
      force: parsed.force,
    });
    await touchInstance(ctx, task, instance, provider, true);
    return fsRemoveOutputSchema.parse({
      instanceId: instance.id,
      path: parsed.path,
      ok: true,
    });
  }

  return undefined;
}
