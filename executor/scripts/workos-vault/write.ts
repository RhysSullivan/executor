#!/usr/bin/env bun

import {
  buildObjectName,
  buildRandomValue,
  formatMs,
  getArg,
  hasFlag,
  measureLatency,
  readEnv,
  resolveContext,
  resolveWorkosClient,
} from "./shared";

function printHelp(): void {
  console.log("Write one object to WorkOS Vault and print latency.");
  console.log("");
  console.log("Usage:");
  console.log("  bun run executor/scripts/workos-vault/write.ts [--name <name>] [--value <secret>] [--context-json <json>]");
  console.log("");
  console.log("Env:");
  console.log("  WORKOS_API_KEY            Required");
  console.log("  WORKOS_VAULT_OBJECT_NAME  Optional object name");
  console.log("  WORKOS_VAULT_SECRET_VALUE Optional secret value");
  console.log("  WORKOS_VAULT_CONTEXT_JSON Optional JSON object (default: {\"workspace_id\":\"local\"})");
}

async function main(): Promise<void> {
  if (hasFlag("help")) {
    printHelp();
    return;
  }

  const workos = resolveWorkosClient();

  const name = getArg("name")
    ?? readEnv("WORKOS_VAULT_OBJECT_NAME")
    ?? buildObjectName("executor-vault-write");
  const value = getArg("value")
    ?? readEnv("WORKOS_VAULT_SECRET_VALUE")
    ?? buildRandomValue(256);
  const contextRaw = getArg("context-json") ?? readEnv("WORKOS_VAULT_CONTEXT_JSON");
  const context = resolveContext(contextRaw);

  const { value: created, durationMs } = await measureLatency(() =>
    workos.vault.createObject({
      name,
      value,
      context,
    })
  );

  console.log("workos vault write complete");
  console.log(`objectId: ${created.id}`);
  console.log(`name: ${name}`);
  console.log(`valueLength: ${value.length}`);
  console.log(`latency: ${formatMs(durationMs)}`);
}

await main();
