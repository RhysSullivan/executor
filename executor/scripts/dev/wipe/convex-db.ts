import { $ } from "bun";

const tables = [
  "accessPolicies",
  "accounts",
  "anonymousSessions",
  "approvals",
  "billingCustomers",
  "billingSeatState",
  "billingSubscriptions",
  "invites",
  "organizationMembers",
  "organizations",
  "sourceCredentials",
  "taskEvents",
  "toolCalls",
  "tasks",
  "openApiSpecCache",
  "toolSources",
  "workspaceMembers",
  "workspaceToolCache",
  "workspaces",
] as const;

const emptyDataPath = "/tmp/convex-empty.json";
const CONCURRENCY = 6;

await Bun.write(emptyDataPath, "[]");

for (let i = 0; i < tables.length; i += CONCURRENCY) {
  const batch = tables.slice(i, i + CONCURRENCY);
  await Promise.all(
    batch.map(async (table) => {
      console.log(`Clearing table: ${table}`);
      await $`bunx convex import --table ${table} --replace -y ${emptyDataPath}`;
    }),
  );
}

console.log("\nKey table checks:");
await $`bunx convex data workspaces`;
await $`bunx convex data organizations`;
await $`bunx convex data accounts`;
