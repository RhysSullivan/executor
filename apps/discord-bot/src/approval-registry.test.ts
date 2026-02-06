import { describe, expect, it } from "vitest";
import { ApprovalRegistry } from "./approval-registry.js";

describe("ApprovalRegistry", () => {
  it("resolves for requester", async () => {
    const registry = new ApprovalRegistry(1_000);
    const pending = registry.open("call_1", "user_a");

    const result = registry.resolve("call_1", "user_a", "approved");
    const decision = await pending;

    expect(result).toBe("resolved");
    expect(decision).toBe("approved");
    expect(registry.size()).toBe(0);
  });

  it("rejects unauthorized actor", async () => {
    const registry = new ApprovalRegistry(1_000);
    const pending = registry.open("call_2", "user_a");

    const unauthorized = registry.resolve("call_2", "user_b", "approved");
    expect(unauthorized).toBe("unauthorized");
    expect(registry.size()).toBe(1);

    registry.cancel("call_2");
    const decision = await pending;
    expect(decision).toBe("denied");
  });

  it("times out to denied", async () => {
    const registry = new ApprovalRegistry(10);
    const pending = registry.open("call_3", "user_a");

    const decision = await pending;
    expect(decision).toBe("denied");
    expect(registry.size()).toBe(0);
  });
});
