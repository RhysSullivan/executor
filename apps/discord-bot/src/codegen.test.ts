import { describe, expect, it } from "vitest";
import { generateCodeFromPrompt } from "./codegen.js";

describe("generateCodeFromPrompt", () => {
  it("maps calendar prompts with heuristic provider", async () => {
    const now = new Date("2026-02-06T10:00:00.000Z");
    const generated = await generateCodeFromPrompt(
      "update my calendar to put dinner with ella at 5 pm",
      { now, provider: "heuristic" },
    );

    expect(generated.provider).toBe("heuristic");
    expect(generated.code).toContain("tools.calendar.update");
    expect(generated.code.toLowerCase()).toContain("dinner with ella");
    expect(generated.rationale).toContain("calendar.update");
  });

  it("supports direct code mode via code prefix", async () => {
    const generated = await generateCodeFromPrompt("code: return 42;", {
      provider: "heuristic",
    });
    expect(generated.code).toBe("return 42;");
    expect(generated.rationale).toContain("direct code");
  });

  it("parses structured output from claude provider", async () => {
    const generated = await generateCodeFromPrompt("make an event", {
      provider: "claude",
      generateWithClaude: async () => ({
        code: "const event = await tools.calendar.update({ title: 'Dinner', startsAt: '2026-02-06T17:00:00.000Z' }); return { event };",
        rationale: "Mapped user prompt to calendar.update",
      }),
    });

    expect(generated.provider).toBe("claude");
    expect(generated.code).toContain("tools.calendar.update");
    expect(generated.rationale).toContain("Mapped");
  });

  it("handles multi-line calendar lists with relative days", async () => {
    const now = new Date("2026-02-06T10:00:00.000Z"); // Friday
    const prompt = [
      "Please add the following to my calendar:",
      "",
      "Dinner 5pm tomorrow",
      "",
      "Lunch 2 pm sunday",
      "",
      "Breakfast 3 am Monday",
    ].join("\n");

    const generated = await generateCodeFromPrompt(prompt, {
      now,
      provider: "heuristic",
    });

    expect(generated.code.match(/tools\.calendar\.update\(/g)?.length).toBe(3);
    expect(generated.code).toContain('"title":"Dinner"');
    expect(generated.code).toContain('"title":"Lunch"');
    expect(generated.code).toContain('"title":"Breakfast"');
    expect(generated.code).toContain('return { message: "Calendar updated", events };');

    const startsAt = [...generated.code.matchAll(/"startsAt":"([^"]+)"/g)]
      .map((match) => match[1])
      .filter((value): value is string => typeof value === "string");
    expect(startsAt).toHaveLength(3);
    if (startsAt.length !== 3) {
      throw new Error("expected 3 startsAt values");
    }
    const dinnerAt = new Date(startsAt[0]!);
    const lunchAt = new Date(startsAt[1]!);
    const breakfastAt = new Date(startsAt[2]!);
    expect(dinnerAt.getDay()).toBe(6); // Saturday
    expect(lunchAt.getDay()).toBe(0); // Sunday
    expect(breakfastAt.getDay()).toBe(1); // Monday
  });
});
