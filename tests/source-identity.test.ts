import { describe, expect, it } from "vitest";

import {
  normalizeNamespaceInput,
  slugifyNamespace,
} from "../packages/react/src/plugins/namespace";

describe("source identity namespace helpers", () => {
  it("preserves underscores while the user is typing", () => {
    expect(normalizeNamespaceInput("archil_useast1")).toBe("archil_useast1");
    expect(normalizeNamespaceInput("archil_")).toBe("archil_");
    expect(normalizeNamespaceInput("_archil")).toBe("_archil");
  });

  it("canonicalizes the saved namespace", () => {
    expect(slugifyNamespace("archil_")).toBe("archil");
    expect(slugifyNamespace("_archil")).toBe("archil");
    expect(slugifyNamespace("Archil USEast1")).toBe("archil_useast1");
  });
});
