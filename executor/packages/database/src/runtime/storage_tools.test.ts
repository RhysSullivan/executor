import { describe, expect, test } from "bun:test";
import { isStorageSystemToolPath } from "./storage_tools";

describe("storage system tool registry", () => {
  test("includes canonical storage tools", () => {
    expect(isStorageSystemToolPath("storage.open")).toBe(true);
    expect(isStorageSystemToolPath("fs.read")).toBe(true);
    expect(isStorageSystemToolPath("kv.set")).toBe(true);
    expect(isStorageSystemToolPath("sqlite.query")).toBe(true);
  });

  test("includes alias tool paths", () => {
    expect(isStorageSystemToolPath("kv.put")).toBe(true);
    expect(isStorageSystemToolPath("kv.del")).toBe(true);
    expect(isStorageSystemToolPath("sqlite.exec")).toBe(true);
    expect(isStorageSystemToolPath("sqlite.bulk_insert")).toBe(true);
  });

  test("rejects unrelated tool paths", () => {
    expect(isStorageSystemToolPath("discover")).toBe(false);
    expect(isStorageSystemToolPath("github.repos.list")).toBe(false);
  });
});
