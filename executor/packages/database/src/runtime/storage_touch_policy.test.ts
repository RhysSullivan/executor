import { describe, expect, test } from "bun:test";
import { shouldTouchStorageOnRead } from "./storage_touch_policy";

describe("storage read touch policy", () => {
  test("defaults to enabled when env value is missing or blank", () => {
    expect(shouldTouchStorageOnRead(undefined)).toBe(true);
    expect(shouldTouchStorageOnRead("")).toBe(true);
    expect(shouldTouchStorageOnRead("   ")).toBe(true);
  });

  test("disables read touches for explicit false values", () => {
    expect(shouldTouchStorageOnRead("0")).toBe(false);
    expect(shouldTouchStorageOnRead("false")).toBe(false);
    expect(shouldTouchStorageOnRead("off")).toBe(false);
    expect(shouldTouchStorageOnRead("no")).toBe(false);
  });

  test("keeps read touches enabled for true-ish values", () => {
    expect(shouldTouchStorageOnRead("1")).toBe(true);
    expect(shouldTouchStorageOnRead("true")).toBe(true);
    expect(shouldTouchStorageOnRead("yes")).toBe(true);
    expect(shouldTouchStorageOnRead("on")).toBe(true);
  });
});
