import { beforeEach, describe, expect, it, vi } from "vitest";
import { ScopeId } from "@executor/sdk";

const mocks = vi.hoisted(() => ({
  useAtomValue: vi.fn(),
  useScope: vi.fn(),
  openApiSourceAtom: vi.fn(),
}));

vi.mock("@effect-atom/atom-react", async () => {
  const actual = await vi.importActual<typeof import("@effect-atom/atom-react")>(
    "@effect-atom/atom-react",
  );
  return {
    ...actual,
    useAtomValue: mocks.useAtomValue,
    Result: {
      ...actual.Result,
      isSuccess: (result: { _tag?: string }) => result?._tag === "Success",
    },
  };
});

vi.mock("@executor/react/api/scope-context", () => ({
  useScope: mocks.useScope,
}));

vi.mock("../../../packages/plugins/openapi/src/react/atoms", () => ({
  openApiSourceAtom: mocks.openApiSourceAtom,
}));

import OpenApiSourceSummary from "../../../packages/plugins/openapi/src/react/OpenApiSourceSummary";

describe("OpenApiSourceSummary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads source config from the owner scope when provided", () => {
    const sourceAtom = Symbol("source-atom");
    mocks.useScope.mockReturnValue("user-scope");
    mocks.openApiSourceAtom.mockReturnValue(sourceAtom);
    mocks.useAtomValue.mockReturnValue({
      _tag: "Success",
      value: {
        config: {
          oauth2: {
            accessTokenSecretId: "access_token",
          },
        },
      },
    });

    OpenApiSourceSummary({ sourceId: "shared", sourceScopeId: ScopeId.make("org-scope") });

    expect(mocks.openApiSourceAtom).toHaveBeenCalledWith("org-scope", "shared");
  });
});
