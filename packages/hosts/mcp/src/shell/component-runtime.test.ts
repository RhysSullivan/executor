import { describe, expect, it } from "@effect/vitest";

import { compileJsx, evaluateComponent } from "./component-runtime";

describe("generated UI component runtime", () => {
  it("accepts export default function components", () => {
    const compiled = compileJsx(`
      const config = { maxHeight: 500 };

      export default function App() {
        return <Card><CardContent>ok</CardContent></Card>;
      }
    `);

    const result = evaluateComponent(compiled, {}, () => Promise.resolve(null));

    expect(compiled).not.toContain("export default");
    expect(result).not.toHaveProperty("error");
    if ("error" in result) return;
    expect(typeof result.component).toBe("function");
    expect(result.config).toEqual({ maxHeight: 500 });
  });

  it("accepts anonymous default exports", () => {
    const compiled = compileJsx(`
      export default function() {
        return <Card><CardContent>ok</CardContent></Card>;
      }
    `);

    const result = evaluateComponent(compiled, {}, () => Promise.resolve(null));

    expect(result).not.toHaveProperty("error");
    if ("error" in result) return;
    expect(typeof result.component).toBe("function");
  });
});
