import { createSqliteExecutor } from "./sqlite-backend";

const databasePath = process.env.DATABASE_PATH
  ?? new URL("../.data/executor.sqlite", import.meta.url).pathname;

const executor = await createSqliteExecutor({
  databasePath,
  workspaceName: "SQLite Example Workspace",
  workspaceRoot: process.cwd(),
});

try {
  const installation = await executor.local.installation();

  const policy = await executor.policies.create({
    resourcePattern: "math.add",
    effect: "allow",
    approvalMode: "auto",
  });

  const secret = await executor.secrets.create({
    name: "demo-api-key",
    value: "secret-value",
  });

  const execution = await executor.executions.create({
    code: "return 20 + 22;",
  });


  const sources = await executor.sources.list();
  const secrets = await executor.secrets.list();
  const policies = await executor.policies.list();

  console.log(JSON.stringify({
    databasePath,
    installation,
    createdPolicyId: policy.id,
    createdSecretId: secret.id,
    execution: {
      id: execution.execution.id,
      status: execution.execution.status,
      resultJson: execution.execution.resultJson,
    },
    counts: {
      sources: sources.length,
      secrets: secrets.length,
      policies: policies.length,
    },
  }, null, 2));
} finally {
  await executor.close();
}
