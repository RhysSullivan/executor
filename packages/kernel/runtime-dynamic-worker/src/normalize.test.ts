import { describe, it, expect } from "vitest";
import { normalizeCode } from "./normalize";

describe("normalizeCode", () => {
  it("passes through an async arrow function", () => {
    const code = "async () => { return 1; }";
    expect(normalizeCode(code)).toBe(code);
  });

  it("passes through an async arrow with params", () => {
    const code = "async (x) => x + 1";
    expect(normalizeCode(code)).toBe(code);
  });

  it("wraps a bare expression in an async arrow", () => {
    const result = normalizeCode("1 + 2");
    expect(result).toContain("async () =>");
    expect(result).toContain("1 + 2");
  });

  it("wraps a function declaration and calls it", () => {
    const result = normalizeCode("function hello() { return 42; }");
    expect(result).toContain("async () =>");
    expect(result).toContain("function hello()");
    expect(result).toContain("return hello();");
  });

  it("wraps an async function declaration", () => {
    const result = normalizeCode("async function run() { return 'ok'; }");
    expect(result).toContain("return run();");
  });

  it("strips markdown code fences", () => {
    const code = "```js\nasync () => 42\n```";
    expect(normalizeCode(code)).toBe("async () => 42");
  });

  it("strips typescript fences", () => {
    const code = "```typescript\nasync () => 42\n```";
    expect(normalizeCode(code)).toBe("async () => 42");
  });

  it("returns noop for empty string", () => {
    expect(normalizeCode("")).toBe("async () => {}");
  });

  it("returns noop for whitespace-only", () => {
    expect(normalizeCode("   \n  ")).toBe("async () => {}");
  });

  it("handles multi-statement code", () => {
    const code = "const a = 1;\nconst b = 2;\na + b";
    const result = normalizeCode(code);
    expect(result).toContain("async () =>");
    expect(result).toContain("const a = 1;");
    expect(result).toContain("a + b");
  });
});
