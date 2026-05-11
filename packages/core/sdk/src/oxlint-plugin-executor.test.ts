import { describe, expect, it } from "@effect/vitest";
import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../../..");

const runOxlintOn = async (name: string, source: string) => {
  const dir = join(repoRoot, ".local", "oxlint-plugin-executor-tests");
  await mkdir(dir, { recursive: true });
  const file = join(dir, name);
  await writeFile(file, source);

  const result = spawnSync(
    join(repoRoot, "node_modules", ".bin", "oxlint"),
    ["-c", join(repoRoot, ".oxlintrc.jsonc"), file, "--deny-warnings"],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );

  await rm(file, { force: true });
  return result;
};

describe("executor oxlint plugin", () => {
  it("rejects expect calls in conditional test branches", async () => {
    const result = await runOxlintOn(
      "conditional-expect.test.ts",
      `
        import { describe, expect, it } from "@effect/vitest";

        const helper = (value: string | undefined) => {
          if (value) {
            expect(value).toBe("ok");
          }
        };

        describe("example", () => {
          it("uses a helper", () => {
            helper("ok");
          });
        });
      `,
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("executor(no-conditional-tests)");
  });

  it("allows unconditional expects over conditional values", async () => {
    const result = await runOxlintOn(
      "unconditional-expect.test.ts",
      `
        import { describe, expect, it } from "@effect/vitest";

        const pick = (flag: boolean) => flag ? "ok" : "no";

        describe("example", () => {
          it("compares the selected value", () => {
            const value = pick(true);
            expect(value).toBe("ok");
          });
        });
      `,
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Found 0 warnings and 0 errors.");
    expect(result.stderr).toBe("");
  });

  it("rejects Schema.Class declarations anywhere", async () => {
    const result = await runOxlintOn(
      "schema-class.ts",
      `
        import { Schema } from "effect";

        export class Thing extends Schema.Class<Thing>("Thing")({
          name: Schema.String,
        }) {}
      `,
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("executor(no-schema-class)");
  });

  it("rejects Schema.TaggedClass declarations anywhere", async () => {
    const result = await runOxlintOn(
      "schema-tagged-class.ts",
      `
        import { Schema } from "effect";

        export class Thing extends Schema.TaggedClass<Thing>()("Thing", {
          name: Schema.String,
        }) {}
      `,
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("executor(no-schema-class)");
  });

  it("allows Schema.TaggedErrorClass (typed errors are exempt)", async () => {
    const result = await runOxlintOn(
      "tagged-error.ts",
      `
        import { Schema } from "effect";

        export class MyError extends Schema.TaggedErrorClass<MyError>()("MyError", {
          message: Schema.String,
        }) {}
      `,
    );

    expect(result.status).toBe(0);
  });

  it("allows structural HTTP payload schemas", async () => {
    const result = await runOxlintOn(
      "struct-payload.ts",
      `
        import { HttpApiEndpoint } from "effect/unstable/httpapi";
        import { Schema } from "effect";

        const CreateThing = Schema.Struct({
          name: Schema.String,
        });

        HttpApiEndpoint.post("createThing", "/things", {
          payload: CreateThing,
        });
      `,
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Found 0 warnings and 0 errors.");
    expect(result.stderr).toBe("");
  });
});
