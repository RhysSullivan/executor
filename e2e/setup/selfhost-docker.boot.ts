// Boot recipe for the selfhost PRODUCTION Docker artifact: build the image
// from this checkout's apps/host-selfhost/Dockerfile (or use
// E2E_SELFHOST_DOCKER_IMAGE, e.g. a published ghcr tag), then run it.
//
// The container runs with HOST networking, for the same reason the dev-server
// target sets EXECUTOR_ALLOW_LOCAL_NETWORK: scenarios boot loopback helper
// servers (OAuth test servers, MCP stubs) on the host and point the instance
// at 127.0.0.1 URLs — under bridge networking the container's loopback is a
// different universe and every one of those dials fails. Host networking
// needs Docker Engine ≥ 26 on Docker Desktop (mac/win); the boot fails loudly
// if the daemon lacks it.
//
// Data is an anonymous volume (the image declares VOLUME /data), removed with
// the container — hermetic per suite, same as the dev target's fresh data dir.
import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { selfhostDockerContainerName } from "../targets/selfhost-docker";
import { waitForHttp, type BootedProcesses } from "./boot";

const exec = promisify(execFile);

export const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

export interface SelfhostDockerBootOptions {
  readonly port: number;
  readonly webBaseUrl: string;
  readonly admin: { readonly email: string; readonly password: string };
  readonly logFile?: string;
}

const log = (file: string | undefined, text: string): void => {
  if (file) appendFileSync(file, `${text}\n`);
  else console.error(`[e2e:selfhost-docker] ${text}`);
};

/**
 * Resolve the image to run: an explicit E2E_SELFHOST_DOCKER_IMAGE wins
 * (pull-if-absent is docker's own behavior at run time); otherwise build
 * from this checkout so the suite tests the artifact the current code
 * produces. The build is the expensive step (~minutes cold, seconds warm —
 * the Dockerfile's layers cache on the lockfile), which is the cost of
 * testing what users deploy instead of a dev server.
 */
const resolveImage = async (logFile?: string): Promise<string> => {
  const pinned = process.env.E2E_SELFHOST_DOCKER_IMAGE;
  if (pinned) return pinned;
  const image = "executor-selfhost:e2e";
  log(logFile, `building ${image} from ${repoRoot}apps/host-selfhost/Dockerfile`);
  await exec("docker", ["build", "-f", "apps/host-selfhost/Dockerfile", "-t", image, "."], {
    cwd: repoRoot,
    maxBuffer: 64 * 1024 * 1024,
  }).catch((error: { stdout?: string; stderr?: string }) => {
    log(logFile, String(error.stdout ?? ""));
    log(logFile, String(error.stderr ?? ""));
    throw new Error("selfhost-docker: image build failed — see log");
  });
  return image;
};

export const bootSelfhostDocker = async (
  options: SelfhostDockerBootOptions,
): Promise<BootedProcesses> => {
  const image = await resolveImage(options.logFile);
  const name = selfhostDockerContainerName(options.port);

  // A previous suite that died without teardown leaves the named container
  // squatting — remove it (and its anonymous volume) before booting.
  await exec("docker", ["rm", "-f", "-v", name]).catch(() => {});

  const args = [
    "run",
    "--detach",
    "--name",
    name,
    "--network",
    "host",
    "-e",
    `PORT=${options.port}`,
    "-e",
    "BETTER_AUTH_SECRET=executor-selfhost-e2e-secret-0123456789",
    "-e",
    `EXECUTOR_BOOTSTRAP_ADMIN_EMAIL=${options.admin.email}`,
    "-e",
    `EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD=${options.admin.password}`,
    "-e",
    `EXECUTOR_WEB_BASE_URL=${options.webBaseUrl}`,
    // Same rationale as the dev target: the harness boots loopback MCP/OAuth
    // test servers and points the instance at them.
    "-e",
    "EXECUTOR_ALLOW_LOCAL_NETWORK=true",
    image,
  ];
  log(options.logFile, `docker ${args.join(" ")}`);
  await exec("docker", args).catch((error: { stderr?: string }) => {
    throw new Error(`selfhost-docker: docker run failed: ${String(error.stderr ?? error)}`);
  });

  try {
    await waitForHttp(`${options.webBaseUrl}/api/health`, { timeoutMs: 120_000 });
  } catch (error) {
    const { stdout } = await exec("docker", ["logs", "--tail", "100", name]).catch(() => ({
      stdout: "(docker logs unavailable)",
    }));
    log(options.logFile, String(stdout));
    await exec("docker", ["rm", "-f", "-v", name]).catch(() => {});
    throw error;
  }

  return {
    teardown: async () => {
      if (options.logFile) {
        const { stdout } = await exec("docker", ["logs", name]).catch(() => ({ stdout: "" }));
        if (stdout) appendFileSync(options.logFile, stdout);
      }
      await exec("docker", ["rm", "-f", "-v", name]).catch(() => {});
    },
    pids: [],
  };
};
