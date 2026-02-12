import { describe, expect, test } from "bun:test";
import { parseArgs, resolveSteps } from "./deploy-prod";

describe("deploy-prod args", () => {
  test("defaults to plan mode with all steps", () => {
    const options = parseArgs([]);
    expect(options.apply).toBe(false);
    expect(options.yes).toBe(false);
    expect(options.force).toBe(false);
    expect(resolveSteps(options)).toEqual(["cloudflare", "env", "convex", "doctor"]);
  });

  test("supports only and skip filters", () => {
    const options = parseArgs(["--apply", "--only", "cloudflare,doctor", "--skip", "doctor"]);
    expect(options.apply).toBe(true);
    expect(resolveSteps(options)).toEqual(["cloudflare"]);
  });

  test("throws on unknown step", () => {
    expect(() => parseArgs(["--only", "bogus"]))
      .toThrow("Unknown step 'bogus'");
  });
});
