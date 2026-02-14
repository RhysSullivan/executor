import { describe, expect, test } from "bun:test";
import { getSourceFaviconCandidates, getSourceFaviconProxyUrl } from "./source-helpers";

describe("getSourceFaviconCandidates", () => {
  test("extracts api host from raw spec paths", () => {
    const candidates = getSourceFaviconCandidates("https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.yaml");

    expect(candidates[0]).toBe("https://raw.githubusercontent.com/favicon.ico");
    expect(candidates).toEqual(
      expect.arrayContaining([
        "https://icons.duckduckgo.com/ip3/raw.githubusercontent.com.ico",
        "https://www.google.com/s2/favicons?domain=raw.githubusercontent.com&sz=32",
        "https://icons.duckduckgo.com/ip3/githubusercontent.com.ico",
        "https://www.google.com/s2/favicons?domain=githubusercontent.com&sz=32",
        "https://icons.duckduckgo.com/ip3/api.github.com.ico",
        "https://www.google.com/s2/favicons?domain=api.github.com&sz=32",
      ]),
    );
  });

  test("returns empty list for malformed urls", () => {
    expect(getSourceFaviconCandidates("not a url")).toEqual([]);
  });

  test("ignores non-domain-like path fragments", () => {
    const candidates = getSourceFaviconCandidates("https://api.example.org/docs/v3.2/openapi.3.2.json");

    expect(candidates).toEqual(
      expect.not.arrayContaining([
        "https://icons.duckduckgo.com/ip3/v3.2.ico",
        "https://icons.duckduckgo.com/ip3/api.2.ico",
      ]),
    );
  });

  test("creates local proxy url for remote favicons", () => {
    expect(getSourceFaviconProxyUrl("https://example.com/favicon.ico")).toBe(
      "/api/favicon?url=https%3A%2F%2Fexample.com%2Ffavicon.ico",
    );
  });

  test("preserves already-local favicon urls", () => {
    expect(getSourceFaviconProxyUrl("/api/favicon?url=https%3A%2F%2Fexample.com%2Ffavicon.ico")).toBe(
      "/api/favicon?url=https%3A%2F%2Fexample.com%2Ffavicon.ico",
    );
  });
});
