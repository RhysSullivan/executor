import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";

import {
  DEFAULT_EXECUTOR_DATA_DIR,
  DEFAULT_LOCAL_DATA_DIR,
} from "@executor/server";

import {
  resolveCliLocalDataDir,
} from "./runtime-paths";

describe("runtime-paths", () => {
  it("uses the web dev local data dir for source-launched CLI runs", () => {
    const originalArgv1 = process.argv[1];

    try {
      process.argv[1] = "/tmp/executor.ts";

      expect(resolveCliLocalDataDir()).toBe(
        join(DEFAULT_EXECUTOR_DATA_DIR, "control-plane-web-dev"),
      );
    } finally {
      if (originalArgv1 === undefined) {
        delete process.argv[1];
      } else {
        process.argv[1] = originalArgv1;
      }
    }
  });

  it("keeps the default local data dir for bundled launches", () => {
    const originalArgv1 = process.argv[1];

    try {
      process.argv[1] = "/tmp/executor";

      expect(resolveCliLocalDataDir()).toBe(DEFAULT_LOCAL_DATA_DIR);
    } finally {
      if (originalArgv1 === undefined) {
        delete process.argv[1];
      } else {
        process.argv[1] = originalArgv1;
      }
    }
  });
});
