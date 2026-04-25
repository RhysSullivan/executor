import { describe, expect, it } from "vitest";

import {
  getUniqueSecretId,
  isSecretIdTaken,
  slugifyForSecretId,
} from "./secret-id";

describe("secret id helpers", () => {
  it("slugifies display names into secret ids", () => {
    expect(slugifyForSecretId("GitHub PAT")).toBe("github-pat");
    expect(slugifyForSecretId("  Client Secret  ")).toBe("client-secret");
  });

  it("returns the base id when it is unused", () => {
    expect(getUniqueSecretId("GitHub PAT", ["openai-api-key"])).toBe("github-pat");
  });

  it("appends a numeric suffix when the base id already exists", () => {
    expect(getUniqueSecretId("GitHub PAT", ["github-pat"])).toBe("github-pat-2");
    expect(getUniqueSecretId("GitHub PAT", ["github-pat", "github-pat-2"])).toBe(
      "github-pat-3",
    );
  });

  it("matches existing ids exactly after trimming", () => {
    expect(isSecretIdTaken("github-pat", [" github-pat "])).toBe(true);
    expect(isSecretIdTaken("github-pat", ["github-pat-2"])).toBe(false);
  });

  it("allows an empty fallback for flows that should start blank", () => {
    expect(getUniqueSecretId("", [], "")).toBe("");
  });
});
