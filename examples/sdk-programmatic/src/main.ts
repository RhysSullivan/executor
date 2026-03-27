/**
 * End-to-end example: using @executor/sdk programmatically.
 *
 * Demonstrates:
 * 1. Creating an executor with in-memory storage
 * 2. Inline tools — pass plain functions from your environment
 * 3. Handling tool approval requests
 * 4. Programmatic secret resolution
 */
import { createExecutor } from "@executor/sdk";

// ---------------------------------------------------------------------------
// 1. Basic execution — in-memory, no sources, auto-approve everything
// ---------------------------------------------------------------------------
async function basicExample() {
  console.log("=== Basic Execution ===\n");

  const executor = await createExecutor({
    storage: "memory",
    onToolApproval: "allow-all",
  });

  try {
    const result = await executor.execute("return 2 + 2;");
    console.log("Result:", result.result); // 4

    const withLogs = await executor.execute(`
      console.log("computing...");
      const x = 10;
      const y = 20;
      console.log("x =", x, "y =", y);
      return x * y;
    `);
    console.log("Result:", withLogs.result); // 200
    console.log("Logs:", withLogs.logs);

    const withError = await executor.execute("throw new Error('oops');");
    console.log("Error:", withError.error); // "oops"
  } finally {
    await executor.close();
  }
}

// ---------------------------------------------------------------------------
// 2. Inline tools — pass plain functions from your environment
// ---------------------------------------------------------------------------
async function inlineToolsExample() {
  console.log("\n=== Inline Tools ===\n");

  const executor = await createExecutor({
    storage: "memory",
    onToolApproval: "allow-all",
    tools: {
      "math.add": {
        description: "Add two numbers",
        execute: async ({ a, b }: { a: number; b: number }) => ({ sum: a + b }),
      },
      "math.multiply": {
        description: "Multiply two numbers",
        execute: async ({ a, b }: { a: number; b: number }) => ({
          product: a * b,
        }),
      },
      "text.reverse": {
        description: "Reverse a string",
        execute: async ({ text }: { text: string }) =>
          text.split("").reverse().join(""),
      },
    },
  });

  try {
    const result = await executor.execute(`
      const sum = await tools.math.add({ a: 3, b: 4 });
      const product = await tools.math.multiply({ a: sum.sum, b: 6 });
      const reversed = await tools.text.reverse({ text: "hello" });
      return { sum: sum.sum, product: product.product, reversed };
    `);
    console.log("Result:", result.result);
    // { sum: 7, product: 42, reversed: "olleh" }
  } finally {
    await executor.close();
  }
}

// ---------------------------------------------------------------------------
// 3. Tool approval — approve or deny tool calls programmatically
// ---------------------------------------------------------------------------
async function approvalExample() {
  console.log("\n=== Tool Approval ===\n");

  const approvalLog: string[] = [];

  const executor = await createExecutor({
    storage: "memory",
    onToolApproval: async (request) => {
      approvalLog.push(
        `[${request.operationKind}] ${request.toolPath} — ${request.reason}`,
      );

      // Example: allow reads, deny writes
      if (request.operationKind === "read") {
        return { approved: true };
      }

      return { approved: false, reason: "Write operations are not allowed" };
    },
  });

  try {
    // List sources (no tools connected yet, but the API works)
    const sources = await executor.sources.list();
    console.log("Sources:", sources.length);

    // Create a policy that requires approval for all tools
    await executor.policies.create({
      resourcePattern: "*",
      effect: "allow",
      approvalMode: "required",
    });
    console.log("Policy created: require approval for all tools");

    console.log("Approval log:", approvalLog);
  } finally {
    await executor.close();
  }
}

// ---------------------------------------------------------------------------
// 4. Secrets — resolve secrets programmatically
// ---------------------------------------------------------------------------
async function secretsExample() {
  console.log("\n=== Programmatic Secrets ===\n");

  const executor = await createExecutor({
    storage: "memory",
    onToolApproval: "allow-all",
    resolveSecret: async ({ secretId }) => {
      // Resolve secrets from environment or any custom source
      const secrets: Record<string, string> = {
        GITHUB_TOKEN: "ghp_example123",
        API_KEY: "sk-example456",
      };
      return secrets[secretId] ?? null;
    },
  });

  try {
    const secretsList = await executor.secrets.list();
    console.log("Secrets count:", secretsList.length);
  } finally {
    await executor.close();
  }
}

// ---------------------------------------------------------------------------
// Run all examples
// ---------------------------------------------------------------------------
async function main() {
  await basicExample();
  await inlineToolsExample();
  await approvalExample();
  await secretsExample();
  console.log("\nAll examples completed.");
}

main().catch(console.error);
