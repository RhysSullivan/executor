import { test, expect, describe } from "bun:test";
import { generateToolDeclarations, generateToolInventory, typecheckCode, type TypecheckResult } from "./typechecker";
import type { ToolDescriptor } from "./types";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const MATH_TOOL: ToolDescriptor = {
  path: "math.add",
  description: "Add two numbers",
  approval: "auto",
  argsType: "{ a: number; b: number }",
  returnsType: "{ result: number }",
};

const ADMIN_TOOL: ToolDescriptor = {
  path: "admin.send_announcement",
  description: "Send an announcement",
  approval: "required",
  argsType: "{ message: string; channel?: string }",
  returnsType: "{ sent: boolean }",
};

const FLAT_TOOL: ToolDescriptor = {
  path: "get_time",
  description: "Get current time",
  approval: "auto",
  argsType: "{}",
  returnsType: "{ iso: string; unix: number }",
};

const ALL_TOOLS = [MATH_TOOL, ADMIN_TOOL, FLAT_TOOL];

// ---------------------------------------------------------------------------
// generateToolDeclarations
// ---------------------------------------------------------------------------

describe("generateToolDeclarations", () => {
  test("empty tools produces empty tools object", () => {
    const result = generateToolDeclarations([]);
    expect(result).toBe("declare const tools: {\n\n};");
  });

  test("flat tool (no dots in path beyond single segment)", () => {
    const result = generateToolDeclarations([FLAT_TOOL]);
    expect(result).toContain("get_time(input: {}): Promise<{ iso: string; unix: number }>;");
  });

  test("nested tool (math.add)", () => {
    const result = generateToolDeclarations([MATH_TOOL]);
    expect(result).toContain("math: {");
    expect(result).toContain("add(input: { a: number; b: number }): Promise<{ result: number }>;");
  });

  test("multiple tools produce correct nesting", () => {
    const result = generateToolDeclarations(ALL_TOOLS);
    // math namespace
    expect(result).toContain("math: {");
    expect(result).toContain("add(input: { a: number; b: number }): Promise<{ result: number }>;");
    // admin namespace
    expect(result).toContain("admin: {");
    expect(result).toContain("send_announcement(input: { message: string; channel?: string }): Promise<{ sent: boolean }>;");
    // flat
    expect(result).toContain("get_time(input: {}): Promise<{ iso: string; unix: number }>;");
  });

  test("missing argsType defaults to Record<string, unknown>", () => {
    const tool: ToolDescriptor = {
      path: "foo.bar",
      description: "test",
      approval: "auto",
    };
    const result = generateToolDeclarations([tool]);
    expect(result).toContain("bar(input: Record<string, unknown>): Promise<unknown>;");
  });

  test("missing returnsType defaults to unknown", () => {
    const tool: ToolDescriptor = {
      path: "baz",
      description: "test",
      approval: "auto",
      argsType: "{ x: number }",
    };
    const result = generateToolDeclarations([tool]);
    expect(result).toContain("baz(input: { x: number }): Promise<unknown>;");
  });
});

// ---------------------------------------------------------------------------
// generateToolInventory
// ---------------------------------------------------------------------------

describe("generateToolInventory", () => {
  test("empty tools returns empty string", () => {
    expect(generateToolInventory([])).toBe("");
  });

  test("includes tool paths and type signatures", () => {
    const result = generateToolInventory(ALL_TOOLS);
    expect(result).toContain("tools.math.add(input: { a: number; b: number }): Promise<{ result: number }>");
    expect(result).toContain("tools.admin.send_announcement(input: { message: string; channel?: string }): Promise<{ sent: boolean }>");
    expect(result).toContain("tools.get_time(input: {}): Promise<{ iso: string; unix: number }>");
  });

  test("shows [approval required] for required-approval tools", () => {
    const result = generateToolInventory(ALL_TOOLS);
    expect(result).toContain("[approval required]");
    // math.add is auto — should NOT have the tag
    const mathLine = result.split("\n").find((l) => l.includes("tools.math.add"));
    expect(mathLine).not.toContain("[approval required]");
    // admin.send_announcement is required — should have the tag
    const adminLine = result.split("\n").find((l) => l.includes("tools.admin.send_announcement"));
    expect(adminLine).toContain("[approval required]");
  });

  test("includes descriptions", () => {
    const result = generateToolInventory(ALL_TOOLS);
    expect(result).toContain("Add two numbers");
    expect(result).toContain("Send an announcement");
    expect(result).toContain("Get current time");
  });
});

// ---------------------------------------------------------------------------
// typecheckCode
// ---------------------------------------------------------------------------

describe("typecheckCode", () => {
  const declarations = generateToolDeclarations(ALL_TOOLS);

  test("valid code passes", () => {
    const result = typecheckCode("return 40 + 2;", declarations);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("valid tool call passes", () => {
    const result = typecheckCode(
      'const sum = await tools.math.add({ a: 1, b: 2 }); return sum.result;',
      declarations,
    );
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("valid async code with await", () => {
    const result = typecheckCode(
      `const time = await tools.get_time({});
       console.log(time.iso);
       return time.unix;`,
      declarations,
    );
    expect(result.ok).toBe(true);
  });

  test("console.log is available", () => {
    const result = typecheckCode('console.log("hello"); return 1;', declarations);
    expect(result.ok).toBe(true);
  });

  test("setTimeout is available", () => {
    const result = typecheckCode(
      'const id = setTimeout(() => {}, 100); clearTimeout(id); return 1;',
      declarations,
    );
    expect(result.ok).toBe(true);
  });

  test("wrong argument types produce errors", () => {
    const result = typecheckCode(
      'const sum = await tools.math.add({ a: "not a number", b: 2 });',
      declarations,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.includes("string") || e.includes("number"))).toBe(true);
  });

  test("missing required argument produces errors", () => {
    const result = typecheckCode(
      "const sum = await tools.math.add({ a: 1 });",
      declarations,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("b"))).toBe(true);
  });

  test("non-existent tool produces errors", () => {
    const result = typecheckCode(
      "const result = await tools.nonexistent.doStuff({});",
      declarations,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("nonexistent"))).toBe(true);
  });

  test("accessing wrong property on result produces errors", () => {
    const result = typecheckCode(
      "const sum = await tools.math.add({ a: 1, b: 2 }); return sum.nonexistent;",
      declarations,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("nonexistent"))).toBe(true);
  });

  test("type errors have adjusted line numbers", () => {
    const code = `const x = 1;
const y = "hello";
const z: number = y;`;
    const result = typecheckCode(code, declarations);
    expect(result.ok).toBe(false);
    // The error should reference line 3 of the user code, not the wrapper
    expect(result.errors.some((e) => e.startsWith("Line 3:"))).toBe(true);
  });

  test("empty declarations (no tools) still works for plain code", () => {
    const emptyDecl = generateToolDeclarations([]);
    const result = typecheckCode("return 42;", emptyDecl);
    expect(result.ok).toBe(true);
  });

  test("complex valid code with multiple tool calls", () => {
    const code = `
const sum = await tools.math.add({ a: 10, b: 20 });
const announcement = await tools.admin.send_announcement({ message: "Sum is " + sum.result });
const time = await tools.get_time({});
console.log(time.iso);
return { sum: sum.result, sent: announcement.sent, time: time.unix };
`;
    const result = typecheckCode(code, declarations);
    expect(result.ok).toBe(true);
  });

  test("optional parameter can be omitted", () => {
    const result = typecheckCode(
      'const r = await tools.admin.send_announcement({ message: "hi" }); return r.sent;',
      declarations,
    );
    expect(result.ok).toBe(true);
  });

  test("optional parameter can be provided", () => {
    const result = typecheckCode(
      'const r = await tools.admin.send_announcement({ message: "hi", channel: "general" }); return r.sent;',
      declarations,
    );
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// schemaTypes integration — verifies that schema type aliases are emitted and
// correctly used by the typechecker
// ---------------------------------------------------------------------------

describe("typecheckCode with schemaTypes", () => {
  const CUSTOMER_SCHEMA_TOOL: ToolDescriptor = {
    path: "stripe.customers.create",
    description: "Create a customer",
    approval: "auto",
    argsType: "{ name: string; email: string }",
    returnsType: "Customer",
    // Only the first tool from a source carries schemaTypes
    schemaTypes: {
      Customer: "{ id: string; name: string; email: string; subscriptions: Subscription[] }",
      Subscription: "{ id: string; status: string; plan: Plan }",
      Plan: "{ id: string; amount: number; currency: string }",
    },
  };

  const CUSTOMER_GET_TOOL: ToolDescriptor = {
    path: "stripe.customers.get",
    description: "Get a customer",
    approval: "auto",
    argsType: "{ id: string }",
    returnsType: "Customer",
    // Subsequent tools do NOT carry schemaTypes (deduplication)
  };

  const STRIPE_TOOLS = [CUSTOMER_SCHEMA_TOOL, CUSTOMER_GET_TOOL];

  test("schema types are emitted in declarations", () => {
    const result = generateToolDeclarations(STRIPE_TOOLS);
    expect(result).toContain("type Customer =");
    expect(result).toContain("type Subscription =");
    expect(result).toContain("type Plan =");
    // Declarations should come before the tools declaration
    const schemaIdx = result.indexOf("type Customer =");
    const toolsIdx = result.indexOf("declare const tools:");
    expect(schemaIdx).toBeLessThan(toolsIdx);
  });

  test("code using schema return types typechecks correctly", () => {
    const decl = generateToolDeclarations(STRIPE_TOOLS);
    const result = typecheckCode(
      `const customer = await tools.stripe.customers.create({ name: "John", email: "john@test.com" });
       const id: string = customer.id;
       const subs: Subscription[] = customer.subscriptions;
       const plan: Plan = subs[0].plan;
       return plan.amount;`,
      decl,
    );
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("wrong property access on schema type produces errors", () => {
    const decl = generateToolDeclarations(STRIPE_TOOLS);
    const result = typecheckCode(
      `const customer = await tools.stripe.customers.get({ id: "cus_123" });
       return customer.nonexistent_field;`,
      decl,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("nonexistent_field"))).toBe(true);
  });

  test("transitive schema types are available (Subscription, Plan)", () => {
    const decl = generateToolDeclarations(STRIPE_TOOLS);
    const result = typecheckCode(
      `const customer = await tools.stripe.customers.get({ id: "cus_123" });
       const sub = customer.subscriptions[0];
       const status: string = sub.status;
       const amount: number = sub.plan.amount;
       const currency: string = sub.plan.currency;
       return { status, amount, currency };`,
      decl,
    );
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("wrong type on schema property produces errors", () => {
    const decl = generateToolDeclarations(STRIPE_TOOLS);
    const result = typecheckCode(
      `const customer = await tools.stripe.customers.get({ id: "cus_123" });
       const amount: string = customer.subscriptions[0].plan.amount;`,
      decl,
    );
    expect(result.ok).toBe(false);
    // amount is number, assigning to string should fail
    expect(result.errors.some((e) => e.includes("number") || e.includes("string"))).toBe(true);
  });
});
