// Desktop-only, on camera: the app ATTACHES to an already-running OS-supervised
// daemon instead of spawning its own sidecar. We start a real supervised gateway
// (the desktop sidecar server in EXECUTOR_SUPERVISED mode → it self-publishes a
// manifest of kind "cli-daemon"), launch the Electron app pointed at the same
// HOME, and prove it attached: the manifest still names OUR daemon's pid (a
// spawned sidecar would be a fresh pid + kind "desktop-sidecar"). The recording
// (session.mp4 + screenshots) is the artifact; the waits are the assertions. No
// launchd — only a throwaway home and one short-lived daemon process.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { _electron } from "playwright";

import { scenario } from "../src/scenario";
import { RunDir } from "../src/services";
import { waitForHttp } from "../setup/boot";

const appDir = fileURLToPath(new URL("../../apps/desktop/", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const sidecarServer = join(appDir, "src/sidecar/server.ts");
const clientDir = join(repoRoot, "apps/local/dist");
const electronBinary = createRequire(join(appDir, "package.json"))("electron") as string;

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });

interface Manifest {
  readonly kind: string;
  readonly pid: number;
}

interface DaemonStart {
  readonly child: ChildProcess;
  readonly ready: boolean;
  readonly stderr: string;
}

/** Spawn the supervised gateway; resolves once it announces EXECUTOR_READY (or
 *  times out / exits early, with `ready: false`). The caller asserts readiness,
 *  so the executor only ever resolves. */
const startSupervisedDaemon = (env: NodeJS.ProcessEnv): Promise<DaemonStart> =>
  new Promise((resolve) => {
    const child = spawn("bun", ["run", sidecarServer], {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    const settle = (ready: boolean) => resolve({ child, ready, stderr });
    const timer = setTimeout(() => settle(false), 60_000);
    child.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("EXECUTOR_READY:")) {
        clearTimeout(timer);
        settle(true);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("exit", () => {
      clearTimeout(timer);
      settle(false);
    });
  });

scenario(
  "Desktop · attaches to the OS-supervised daemon instead of spawning a sidecar",
  { timeout: 240_000 },
  Effect.gen(function* () {
    const runDir = yield* RunDir;
    yield* Effect.promise(() => run(runDir));
  }),
);

const run = async (runDir: string) => {
  const home = mkdtempSync(join(tmpdir(), "executor-attach-e2e-"));
  const dataDir = join(home, ".executor");
  const manifestPath = join(dataDir, "server-control", "server.json");
  const videoTmp = join(runDir, ".video-tmp");
  const port = await freePort();

  let daemon: ChildProcess | undefined;
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
  let stepIndex = 0;

  try {
    const started = await startSupervisedDaemon({
      ...process.env,
      HOME: home,
      EXECUTOR_SUPERVISED: "1",
      EXECUTOR_DATA_DIR: dataDir,
      EXECUTOR_PORT: String(port),
      EXECUTOR_HOST: "127.0.0.1",
      EXECUTOR_AUTH_PASSWORD: "supervised-attach-film",
      EXECUTOR_CLIENT_DIR: clientDir,
    });
    daemon = started.child;
    expect(started.ready, `supervised daemon became ready; stderr:\n${started.stderr}`).toBe(true);
    await waitForHttp(`http://127.0.0.1:${port}/`, { timeoutMs: 30_000 });

    const daemonManifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
    expect(daemonManifest.kind, "the running daemon advertises itself as cli-daemon").toBe(
      "cli-daemon",
    );
    const daemonPid = daemonManifest.pid;

    app = await _electron.launch({
      executablePath: electronBinary,
      args: [appDir],
      cwd: appDir,
      env: { ...process.env, HOME: home },
      recordVideo: { dir: videoTmp, size: { width: 1280, height: 800 } },
      timeout: 120_000,
    });

    const page = await app.firstWindow({ timeout: 120_000 });
    const step = async (label: string, body: () => Promise<void>) => {
      await body();
      stepIndex += 1;
      const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      await page.screenshot({
        path: join(runDir, `${String(stepIndex).padStart(2, "0")}-${slug}.png`),
      });
    };

    // The window only loads the console once the app has a connection — and it
    // attaches to the supervised daemon before it would ever spawn a sidecar.
    await step("desktop boots into the console", async () => {
      await page.getByText("Settings").first().waitFor({ timeout: 120_000 });
    });

    // The proof it ATTACHED rather than spawned: the manifest is untouched —
    // same pid, still cli-daemon. A managed sidecar would have rewritten it to
    // kind "desktop-sidecar" with a fresh child pid.
    await step("server manifest still names the supervised daemon", async () => {
      const after = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
      expect(after.kind, "still the supervised daemon (not a desktop sidecar)").toBe("cli-daemon");
      expect(after.pid, "the desktop attached to our daemon, not a new sidecar").toBe(daemonPid);
    });
  } finally {
    const page = app?.windows()[0];
    const video = page?.video();
    await app?.close().catch(() => {});
    const recordedPath = await video?.path().catch(() => undefined);
    if (recordedPath && existsSync(recordedPath)) {
      await promisify(execFile)("ffmpeg", [
        "-y",
        "-i",
        recordedPath,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "26",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        join(runDir, "session.mp4"),
      ]).catch(() => {});
    }
    daemon?.kill("SIGTERM");
    rmSync(videoTmp, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
};
