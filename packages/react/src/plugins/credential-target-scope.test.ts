import { describe, expect, it } from "@effect/vitest";

import {
  credentialTargetScopeOptions,
  normalizeCredentialTargetScope,
} from "./credential-target-scope";

// ---------------------------------------------------------------------------
// The credential-target owner selection defaults to Personal (`user`). The
// shared `useCredentialTargetScope` hook seeds React state with `"user"` when
// no `initialOwner` is passed, and the options list Personal first so the
// fallback (`options[0]`) is Personal too. These pure invariants pin that
// default without a DOM/React renderer.
// ---------------------------------------------------------------------------

describe("credentialTargetScopeOptions", () => {
  it("lists Personal (user) first so the default owner is Personal", () => {
    const options = credentialTargetScopeOptions();
    expect(options[0]?.owner).toBe("user");
    expect(options[0]?.label).toBe("Personal");
    expect(options.map((option) => option.owner)).toEqual(["user", "org"]);
  });
});

describe("normalizeCredentialTargetScope", () => {
  it("keeps a recognized owner", () => {
    const options = credentialTargetScopeOptions();
    expect(normalizeCredentialTargetScope("org", options)).toBe("org");
    expect(normalizeCredentialTargetScope("user", options)).toBe("user");
  });

  it("falls back to Personal (the first option) for an unrecognized owner", () => {
    const options = credentialTargetScopeOptions().filter((option) => option.owner === "user");
    // An owner not present in the (filtered) options falls back to options[0].
    expect(normalizeCredentialTargetScope("org", options)).toBe("user");
  });
});
