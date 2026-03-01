#!/usr/bin/env bun

import {
  buildObjectName,
  buildRandomValue,
  formatMs,
  getArg,
  hasFlag,
  measureLatency,
  printStats,
  readBoolean,
  readEnv,
  readInt,
  resolveContext,
  resolveWorkosClient,
} from "./shared";

function printHelp(): void {
  console.log("Measure WorkOS Vault write and read latency.");
  console.log("");
  console.log("Usage:");
  console.log("  bun run executor/scripts/workos-vault/latency.ts [--iterations <n>] [--warmup <n>] [--object-id <id>] [--value-bytes <n>] [--no-delete]");
  console.log("");
  console.log("Env:");
  console.log("  WORKOS_API_KEY                   Required");
  console.log("  WORKOS_VAULT_OBJECT_ID           Optional existing object id");
  console.log("  WORKOS_VAULT_CONTEXT_JSON        Optional JSON object for create context");
  console.log("  WORKOS_VAULT_ITERATIONS          Optional, default 10");
  console.log("  WORKOS_VAULT_WARMUP_ITERATIONS   Optional, default 1");
  console.log("  WORKOS_VAULT_VALUE_BYTES         Optional, default 256");
  console.log("  WORKOS_VAULT_DELETE_AFTER        Optional, default true");
}

async function main(): Promise<void> {
  if (hasFlag("help")) {
    printHelp();
    return;
  }

  const workos = resolveWorkosClient();

  const iterations = Math.max(
    1,
    readInt(getArg("iterations") ?? readEnv("WORKOS_VAULT_ITERATIONS"), 10),
  );
  const warmupIterations = Math.max(
    0,
    readInt(getArg("warmup") ?? readEnv("WORKOS_VAULT_WARMUP_ITERATIONS"), 1),
  );
  const valueBytes = Math.max(
    16,
    readInt(getArg("value-bytes") ?? readEnv("WORKOS_VAULT_VALUE_BYTES"), 256),
  );
  const context = resolveContext(readEnv("WORKOS_VAULT_CONTEXT_JSON"));

  const shouldDeleteAfter = hasFlag("no-delete")
    ? false
    : readBoolean(readEnv("WORKOS_VAULT_DELETE_AFTER"), true);

  const providedObjectId = getArg("object-id") ?? readEnv("WORKOS_VAULT_OBJECT_ID");

  let objectId = providedObjectId;
  let createdObject = false;

  if (!objectId) {
    const initialValue = buildRandomValue(valueBytes);
    const objectName = buildObjectName("executor-vault-latency");
    const created = await workos.vault.createObject({
      name: objectName,
      value: initialValue,
      context,
    });
    objectId = created.id;
    createdObject = true;
  }

  if (!objectId) {
    throw new Error("Failed to resolve a WorkOS Vault object id");
  }

  const writeLatencies: number[] = [];
  const readLatencies: number[] = [];
  const roundtripLatencies: number[] = [];

  for (let i = 0; i < warmupIterations; i += 1) {
    const value = buildRandomValue(valueBytes);
    await workos.vault.updateObject({
      id: objectId,
      value,
    });
    await workos.vault.readObject({
      id: objectId,
    });
  }

  for (let i = 0; i < iterations; i += 1) {
    const value = buildRandomValue(valueBytes);
    const roundtripStartedAt = performance.now();

    const writeResult = await measureLatency(() =>
      workos.vault.updateObject({
        id: objectId,
        value,
      })
    );
    const readResult = await measureLatency(() =>
      workos.vault.readObject({
        id: objectId,
      })
    );

    const readValue = typeof readResult.value.value === "string" ? readResult.value.value : "";
    if (readValue !== value) {
      throw new Error(`Read-back mismatch on iteration ${i + 1}`);
    }

    writeLatencies.push(writeResult.durationMs);
    readLatencies.push(readResult.durationMs);
    roundtripLatencies.push(performance.now() - roundtripStartedAt);
  }

  let cleanupLatencyMs: number | null = null;
  if (createdObject && shouldDeleteAfter) {
    const cleanup = await measureLatency(() =>
      workos.vault.deleteObject({
        id: objectId,
      })
    );
    cleanupLatencyMs = cleanup.durationMs;
  }

  console.log("workos vault latency benchmark complete");
  console.log(`objectId: ${objectId}${createdObject ? " (created by script)" : " (provided)"}`);
  console.log(`iterations: ${iterations}`);
  console.log(`warmupIterations: ${warmupIterations}`);
  console.log(`valueBytes: ${valueBytes}`);
  console.log(`cleanup: ${createdObject ? (shouldDeleteAfter ? "deleted" : "kept") : "not-applicable"}`);
  if (cleanupLatencyMs !== null) {
    console.log(`cleanupLatency: ${formatMs(cleanupLatencyMs)}`);
  }
  printStats("write", writeLatencies);
  printStats("read", readLatencies);
  printStats("roundtrip", roundtripLatencies);
}

await main();
