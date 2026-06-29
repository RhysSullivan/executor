import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  canonicalizeStdioConfig,
  parseStdioArgs,
  parseStdioEnv,
  sameCanonicalStdioConfig,
  stdioEnvToText,
} from "./stdio-config";

describe("stdio config helpers", () => {
  it.effect("preserves current argument parsing behavior", () =>
    Effect.sync(() => {
      expect(parseStdioArgs('  -y "package with spaces" --flag=value  ')).toEqual([
        "-y",
        "package with spaces",
        "--flag=value",
      ]);
      expect(parseStdioArgs("   ")).toEqual([]);
    }),
  );

  it.effect("parses valid environment lines", () =>
    Effect.sync(() => {
      expect(parseStdioEnv("FOO=bar\nEMPTY=\n  SPACED = value  ")).toEqual({
        ok: true,
        env: { FOO: "bar", EMPTY: "", SPACED: "value" },
      });
    }),
  );

  it.effect("unwraps quoted values and double-quoted escapes", () =>
    Effect.sync(() => {
      expect(parseStdioEnv("A=' literal ' value '\nB=\"line\\n\\t\\r\\\\\\\"\"")).toEqual({
        ok: true,
        env: { A: " literal ' value ", B: 'line\n\t\r\\"' },
      });
    }),
  );

  it.effect("reports missing equals", () =>
    Effect.sync(() => {
      expect(parseStdioEnv("FOO")).toEqual({
        ok: false,
        error: { kind: "missing_equals", line: 1 },
      });
    }),
  );

  it.effect("reports empty keys", () =>
    Effect.sync(() => {
      expect(parseStdioEnv("=value")).toEqual({ ok: false, error: { kind: "empty_key", line: 1 } });
    }),
  );

  it.effect("reports invalid keys", () =>
    Effect.sync(() => {
      expect(parseStdioEnv("1_BAD=value")).toEqual({
        ok: false,
        error: { kind: "invalid_key", line: 1, key: "1_BAD" },
      });
    }),
  );

  it.effect("reports duplicate keys", () =>
    Effect.sync(() => {
      expect(parseStdioEnv("FOO=one\nFOO=two")).toEqual({
        ok: false,
        error: { kind: "duplicate_key", line: 2, key: "FOO" },
      });
    }),
  );

  it.effect("returns undefined env for an empty textarea", () =>
    Effect.sync(() => {
      expect(parseStdioEnv("\n  \n")).toEqual({ ok: true, env: undefined });
    }),
  );

  it.effect("serializes env text that round trips through the parser", () =>
    Effect.sync(() => {
      const env = {
        A: " value ",
        B: "line\nnext",
        C: "plain",
        D: "'hello'",
        E: '"hello"',
      };
      expect(parseStdioEnv(stdioEnvToText(env))).toEqual({ ok: true, env });
    }),
  );

  it.effect("compares canonical env independent of key order", () =>
    Effect.sync(() => {
      expect(
        sameCanonicalStdioConfig(
          canonicalizeStdioConfig({ command: " npx ", args: ["a"], env: { B: "2", A: "1" } }),
          canonicalizeStdioConfig({ command: "npx", args: ["a"], env: { A: "1", B: "2" } }),
        ),
      ).toBe(true);
    }),
  );
});
