import { expect, test } from "bun:test";
import { formatTypeExpressionForClient } from "./type-format";

test("formatTypeExpressionForClient formats compact object signatures", () => {
  const raw = '{id:number;name:string;labels:components["schemas"]["runner-label"][]}';
  const formatted = formatTypeExpressionForClient(raw);

  expect(formatted).toContain("id: number");
  expect(formatted).toContain("name: string");
  expect(formatted).toContain('components["schemas"]["runner-label"][]');
});

test("formatTypeExpressionForClient handles partial expressions safely", () => {
  const raw = "{ id: number";
  const formatted = formatTypeExpressionForClient(raw);
  expect(typeof formatted).toBe("string");
  expect(formatted && formatted.length > 0).toBeTrue();
});
