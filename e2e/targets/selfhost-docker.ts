// The PRODUCTION self-host artifact as a target: the Docker image from
// apps/host-selfhost/Dockerfile (production Vite build, `bun src/serve.ts`,
// /data volume) instead of the dev server. Same surface as the selfhost
// target — same bootstrap admin, same Better Auth sign-in, same MCP consent —
// so the whole scenario suite runs against what users actually deploy. Boot
// lives in setup/selfhost-docker.globalsetup.ts.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { Effect } from "effect";

import { cookieConsentStrategy } from "@executor-js/mcporter";

import { e2ePort } from "../src/ports";
import type { Identity, Target } from "../src/target";
import { waitForHttp } from "../setup/boot";
import { SELFHOST_ADMIN, signInSession } from "./selfhost";

const exec = promisify(execFile);

export const SELFHOST_DOCKER_PORT = e2ePort("E2E_SELFHOST_DOCKER_PORT", 5);
export const SELFHOST_DOCKER_BASE_URL =
  process.env.E2E_SELFHOST_DOCKER_URL ?? `http://localhost:${SELFHOST_DOCKER_PORT}`;

/** The globalsetup's container name — derived the same way on both sides. */
export const selfhostDockerContainerName = (port: number): string =>
  `executor-e2e-selfhost-docker-${port}`;

export const selfhostDockerTarget = (): Target => ({
  name: "selfhost-docker",
  baseUrl: SELFHOST_DOCKER_BASE_URL,
  mcpUrl: `${SELFHOST_DOCKER_BASE_URL}/mcp`,
  capabilities: new Set(["api", "browser", "mcp-oauth"]),
  newIdentity: () =>
    Effect.promise(async (): Promise<Identity> => {
      const { cookieHeader, cookies } = await signInSession(
        SELFHOST_DOCKER_BASE_URL,
        SELFHOST_ADMIN,
      );
      return {
        label: SELFHOST_ADMIN.email,
        credentials: SELFHOST_ADMIN,
        headers: { cookie: cookieHeader },
        cookies,
      };
    }),
  mcpConsent: (identity: Identity) =>
    cookieConsentStrategy({
      appBaseUrl: SELFHOST_DOCKER_BASE_URL,
      email: identity.credentials?.email ?? SELFHOST_ADMIN.email,
      password: identity.credentials?.password ?? SELFHOST_ADMIN.password,
    }),
  // `docker restart` keeps the container's volume — exactly a user upgrading
  // or rebooting their deployment. Only when this process owns the container
  // (attach mode can't assume the instance is restartable docker).
  ...(process.env.E2E_SELFHOST_DOCKER_URL
    ? {}
    : {
        restart: () =>
          Effect.promise(async () => {
            await exec("docker", ["restart", selfhostDockerContainerName(SELFHOST_DOCKER_PORT)]);
            await waitForHttp(`${SELFHOST_DOCKER_BASE_URL}/api/health`, { timeoutMs: 120_000 });
          }),
      }),
});
