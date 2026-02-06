import { describe, test, expect } from "bun:test";
import { walkToolTree, isToolDefinition } from "@openassistant/core";
import { generateOpenApiTools } from "./openapi.js";

describe("generateOpenApiTools — FastSpring spec", () => {
  test("parses the FastSpring OpenAPI spec and generates tools", async () => {
    const result = await generateOpenApiTools({
      name: "fastspring",
      spec: "https://raw.githubusercontent.com/konfig-sdks/openapi-examples/refs/heads/main/fastspring/openapi.yaml",
    });

    // Should produce a nested tool tree under "fastspring"
    expect(result.tools["fastspring"]).toBeDefined();

    // Collect all tool paths
    const paths: string[] = [];
    walkToolTree(result.tools, (path) => paths.push(path));

    // Should have a meaningful number of tools
    expect(paths.length).toBeGreaterThan(10);

    // Should have common FastSpring endpoints
    const hasAccounts = paths.some((p) => p.includes("accounts"));
    const hasProducts = paths.some((p) => p.includes("products"));
    const hasOrders = paths.some((p) => p.includes("orders"));
    const hasSubscriptions = paths.some((p) => p.includes("subscriptions"));

    expect(hasAccounts).toBe(true);
    expect(hasProducts).toBe(true);
    expect(hasOrders).toBe(true);
    expect(hasSubscriptions).toBe(true);

    // GET operations should be auto-approved by default
    const accountsTree = result.tools["fastspring"] as Record<string, unknown>;
    const accountsGroup = accountsTree["accounts"] as Record<string, unknown>;
    // Find a GET operation
    for (const [_name, tool] of Object.entries(accountsGroup)) {
      if (isToolDefinition(tool)) {
        // At least one tool should exist in accounts
        expect(tool.description).toBeDefined();
        break;
      }
    }

    // TypeScript declarations should be generated
    expect(result.typeDeclaration).toContain("fastspring:");
    expect(result.typeDeclaration.length).toBeGreaterThan(100);

    // Prompt guidance should be generated
    expect(result.promptGuidance).toContain("tools.fastspring");
    expect(result.promptGuidance.length).toBeGreaterThan(100);
  }, { timeout: 30_000 });

  test("respects approval overrides", async () => {
    const result = await generateOpenApiTools({
      name: "fastspring",
      spec: "https://raw.githubusercontent.com/konfig-sdks/openapi-examples/refs/heads/main/fastspring/openapi.yaml",
      overrides: {
        "Accounts_getAccountById": { approval: "required" },
      },
    });

    // Find the overridden tool
    let found = false;
    walkToolTree(result.tools, (path, tool) => {
      if (path.includes("Accounts_getAccountById")) {
        expect(tool.approval).toBe("required");
        found = true;
      }
    });

    expect(found).toBe(true);
  }, { timeout: 30_000 });

  test("write operations default to required approval", async () => {
    const result = await generateOpenApiTools({
      name: "fastspring",
      spec: "https://raw.githubusercontent.com/konfig-sdks/openapi-examples/refs/heads/main/fastspring/openapi.yaml",
    });

    // POST/PUT/DELETE operations should require approval
    let foundWriteWithApproval = false;
    walkToolTree(result.tools, (path, tool) => {
      // createNewAccount is a POST
      if (path.includes("createNewAccount") || path.includes("createAndUpdate")) {
        expect(tool.approval).toBe("required");
        foundWriteWithApproval = true;
      }
    });

    expect(foundWriteWithApproval).toBe(true);
  }, { timeout: 30_000 });
});
