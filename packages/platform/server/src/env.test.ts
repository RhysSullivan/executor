import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadMonorepoRootEnv } from "./env";

const tempDirs: string[] = [];

const makeTempDir = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "executor-server-env-"));
  tempDirs.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("loadMonorepoRootEnv", () => {
  it("loads root .env.local values when running from a workspace child directory", async () => {
    const root = await makeTempDir();
    await writeFile(join(root, "package.json"), JSON.stringify({
      private: true,
      workspaces: ["apps/*", "packages/*/*"],
    }));
    await writeFile(join(root, ".env.local"), "GOOGLE_CLIENT_ID=test-client\nGOOGLE_CLIENT_SECRET=test-secret\n");
    const child = join(root, "apps", "executor");
    await mkdir(child, { recursive: true });

    const env: NodeJS.ProcessEnv = {};
    const result = loadMonorepoRootEnv({
      cwd: child,
      env,
    });

    expect(result.rootDir).toBe(root);
    expect(result.loadedFiles).toContain(join(root, ".env.local"));
    expect(env.GOOGLE_CLIENT_ID).toBe("test-client");
    expect(env.GOOGLE_CLIENT_SECRET).toBe("test-secret");
  });

  it("does not override explicit process environment values", async () => {
    const root = await makeTempDir();
    await writeFile(join(root, "package.json"), JSON.stringify({
      private: true,
      workspaces: ["apps/*", "packages/*/*"],
    }));
    await writeFile(join(root, ".env.local"), "GOOGLE_CLIENT_ID=file-client\n");
    const child = join(root, "apps", "executor");
    await mkdir(child, { recursive: true });

    const env: NodeJS.ProcessEnv = {
      GOOGLE_CLIENT_ID: "shell-client",
    };
    loadMonorepoRootEnv({
      cwd: child,
      env,
    });

    expect(env.GOOGLE_CLIENT_ID).toBe("shell-client");
  });
});
