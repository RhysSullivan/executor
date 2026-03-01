#!/usr/bin/env bun

import {
  formatMs,
  getArg,
  hasFlag,
  measureLatency,
  readEnv,
  resolveWorkosClient,
} from "./shared";

function printHelp(): void {
  console.log("Read one object from WorkOS Vault and print latency.");
  console.log("");
  console.log("Usage:");
  console.log("  bun run executor/scripts/workos-vault/read.ts --object-id <id> [--show-value]");
  console.log("");
  console.log("Env:");
  console.log("  WORKOS_API_KEY         Required");
  console.log("  WORKOS_VAULT_OBJECT_ID Required when --object-id is not provided");
}

async function main(): Promise<void> {
  if (hasFlag("help")) {
    printHelp();
    return;
  }

  const workos = resolveWorkosClient();
  const objectId = getArg("object-id") ?? readEnv("WORKOS_VAULT_OBJECT_ID");
  if (!objectId) {
    throw new Error("Missing object id. Pass --object-id <id> or set WORKOS_VAULT_OBJECT_ID.");
  }

  const { value: object, durationMs } = await measureLatency(() =>
    workos.vault.readObject({
      id: objectId,
    })
  );

  const value = typeof object.value === "string" ? object.value : "";
  const showValue = hasFlag("show-value");

  console.log("workos vault read complete");
  console.log(`objectId: ${object.id}`);
  console.log(`name: ${object.name}`);
  console.log(`valueLength: ${value.length}`);
  console.log(`latency: ${formatMs(durationMs)}`);

  if (showValue) {
    console.log(`value: ${value}`);
  }
}

await main();
