import { describe, expect, it } from "vitest";
import { formatDiscordResponse } from "./format-response.js";

describe("formatDiscordResponse", () => {
  it("returns trimmed text and footer", () => {
    const output = formatDiscordResponse({
      text: "  Added dinner to your calendar.  ",
      footer: "planner details",
    });

    expect(output.message).toBe("Added dinner to your calendar.");
    expect(output.footer).toBe("planner details");
  });

  it("falls back to Done when text is empty", () => {
    const output = formatDiscordResponse({
      text: "   ",
    });

    expect(output.message).toBe("Done.");
    expect(output.footer).toBeUndefined();
  });
});
