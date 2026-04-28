import { describe, expect, it } from "@effect/vitest";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, cp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type CommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

const repoRoot = resolve(dirnameOf(import.meta.url), "..");
const cliRoot = join(repoRoot, "apps/cli");
const distDir = join(cliRoot, "dist");

function dirnameOf(url: string): string {
  return resolve(fileURLToPath(new URL(".", url)));
}

const runCommand = async (
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CommandResult> => {
  const child = spawn(command, [...args], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const exitCode = await new Promise<number>((resolveExitCode, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      resolveExitCode(code ?? -1);
    });
  });

  return { exitCode, stdout, stderr };
};

const listen = async (server: ReturnType<typeof createServer>): Promise<number> =>
  new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to resolve local release server address"));
        return;
      }
      resolvePort(address.port);
    });
  });

const closeServer = async (server: ReturnType<typeof createServer>): Promise<void> =>
  new Promise((resolveClose, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolveClose();
    });
  });

const currentRuntimeBinaryName = process.platform === "win32" ? "executor.exe" : "executor";
const isSupportedPlatform =
  ["darwin", "linux", "win32"].includes(process.platform) &&
  ["x64", "arm64"].includes(process.arch);

describe("release bootstrap smoke", () => {
  it("fresh wrapper install bootstraps locally hosted release assets and stays runnable", async () => {
    if (!isSupportedPlatform) {
      return;
    }

    const build = await runCommand("bun", ["run", "src/build.ts", "binary", "--single"], cliRoot);
    expect(build.exitCode, build.stderr || build.stdout).toBe(0);

    const assets = await runCommand("bun", ["run", "src/build.ts", "release-assets"], cliRoot);
    expect(assets.exitCode, assets.stderr || assets.stdout).toBe(0);

    const wrapperDir = join(distDir, "executor");
    const assetNames = (await readdir(distDir))
      .filter((entry) => /^executor-.*\.(?:tar\.gz|zip)$/.test(entry))
      .sort();

    expect(assetNames, `expected one current-platform asset in ${distDir}`).toHaveLength(1);

    const assetName = assetNames[0]!;
    const assetPath = join(distDir, assetName);
    const tempRoot = await mkdtemp(join(tmpdir(), "executor-release-bootstrap-"));
    const installedPackageDir = join(tempRoot, "executor");

    await cp(wrapperDir, installedPackageDir, { recursive: true });

    const originalPackageJson = JSON.parse(
      await readFile(join(installedPackageDir, "package.json"), "utf8"),
    ) as { version: string; homepage?: string };

    const assetRoute = `/releases/download/v${originalPackageJson.version}/${assetName}`;
    const server = createServer(async (request, response) => {
      if (request.url !== assetRoute) {
        response.statusCode = 404;
        response.end("not found");
        return;
      }

      const body = await readFile(assetPath);
      response.statusCode = 200;
      response.setHeader("content-length", String(body.byteLength));
      response.end(body);
    });

    try {
      const port = await listen(server);
      const packageJsonPath = join(installedPackageDir, "package.json");
      await writeFile(
        packageJsonPath,
        JSON.stringify(
          {
            ...originalPackageJson,
            homepage: `http://127.0.0.1:${port}`,
          },
          null,
          2,
        ) + "\n",
      );

      const firstRun = await runCommand(
        process.execPath,
        [join(installedPackageDir, "bin", "executor"), "--help"],
        installedPackageDir,
      );
      const combinedOutput = `${firstRun.stdout}\n${firstRun.stderr}`;

      expect(firstRun.exitCode, combinedOutput).toBe(0);
      expect(combinedOutput).toContain("downloading release asset");
      expect(combinedOutput).toContain(
        `installed ${basename(assetName, ".zip").replace(/\.tar\.gz$/, "")}`,
      );
      expect(combinedOutput).not.toContain("core_bg.wasm");
      expect(combinedOutput).not.toContain("ENOENT");

      const installedBinaryPath = join(
        installedPackageDir,
        "bin",
        "runtime",
        currentRuntimeBinaryName,
      );
      const installedBinaryStat = await readFile(installedBinaryPath);
      expect(installedBinaryStat.byteLength).toBeGreaterThan(0);

      const probeServer = createServer((_, response) => {
        response.statusCode = 204;
        response.end();
      });
      const webPort = await listen(probeServer);
      await closeServer(probeServer);

      const webProcess = spawn(
        process.execPath,
        [join(installedPackageDir, "bin", "executor"), "web", "--port", String(webPort)],
        {
          cwd: installedPackageDir,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      let webStdout = "";
      let webStderr = "";
      webProcess.stdout.setEncoding("utf8");
      webProcess.stdout.on("data", (chunk) => {
        webStdout += chunk;
      });
      webProcess.stderr.setEncoding("utf8");
      webProcess.stderr.on("data", (chunk) => {
        webStderr += chunk;
      });

      try {
        const deadline = Date.now() + 30_000;
        let rootResponse: Response | null = null;
        while (Date.now() < deadline) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
          try {
            rootResponse = await fetch(`http://127.0.0.1:${webPort}/`);
            if (rootResponse.ok) {
              break;
            }
          } catch {
            // keep polling until the server is ready
          }
        }

        expect(rootResponse, `${webStdout}\n${webStderr}`).not.toBeNull();
        expect(rootResponse!.status, `${webStdout}\n${webStderr}`).toBe(200);
        const rootHtml = await rootResponse!.text();
        expect(rootHtml.toLowerCase()).toContain("<html");

        const assetJs = rootHtml.match(/src="([^"]+\.js)"/)?.[1];
        const assetCss = rootHtml.match(/href="([^"]+\.css)"/)?.[1];
        expect(assetJs, rootHtml).toBeDefined();
        expect(assetCss, rootHtml).toBeDefined();

        const assetJsResponse = await fetch(`http://127.0.0.1:${webPort}${assetJs}`);
        expect(assetJsResponse.status, `${webStdout}\n${webStderr}`).toBe(200);

        const assetCssResponse = await fetch(`http://127.0.0.1:${webPort}${assetCss}`);
        expect(assetCssResponse.status, `${webStdout}\n${webStderr}`).toBe(200);

        const docsResponse = await fetch(`http://127.0.0.1:${webPort}/docs`);
        expect(docsResponse.status, `${webStdout}\n${webStderr}`).toBe(200);

        const secondRun = await runCommand(
          process.execPath,
          [join(installedPackageDir, "bin", "executor"), "--help"],
          installedPackageDir,
        );
        const secondCombinedOutput = `${secondRun.stdout}\n${secondRun.stderr}`;

        expect(secondRun.exitCode, secondCombinedOutput).toBe(0);
        expect(secondCombinedOutput).not.toContain("downloading release asset");
      } finally {
        webProcess.kill("SIGTERM");
        await Promise.race([
          new Promise((resolveClose) => webProcess.once("close", () => resolveClose(undefined))),
          new Promise((resolveClose) => setTimeout(resolveClose, 5_000)),
        ]);
        if (webProcess.exitCode === null) {
          if (process.platform === "win32") {
            webProcess.kill();
          } else {
            webProcess.kill("SIGKILL");
          }
        }
      }
    } finally {
      await closeServer(server);
      await rm(tempRoot, { recursive: true, force: true });
    }
  }, 180_000);
});
