// The e2e dev CLI: the same primitives scenarios use, interactive.
//
//   bun scripts/cli.ts up selfhost [--share] [--keep-data]
//   bun scripts/cli.ts up cloud    [--share]
//   bun scripts/cli.ts status
//   bun scripts/cli.ts identity <target> [--no-org]
//   bun scripts/cli.ts api <target> <group.endpoint> [json]
//   bun scripts/cli.ts mcp <target> tools | call <tool> [json]
//   bun scripts/cli.ts ledger <target> [workos|autumn]
//   bun scripts/cli.ts browse <target> <step…>   (goto/click/see/…; show|undo|reset)
//   bun scripts/cli.ts promote <target> "<scenario name>"
//   bun scripts/cli.ts logs <target>
//   bun scripts/cli.ts down <target>
//
// Develop against a live instance with the exact machinery the tests use
// (same boot recipe, same Target/identity/surfaces), then crystallize the
// journey into a scenario. `up` leaves the instance running until `down` —
// it IS the handoff demo (AGENTS.md: evidence, not assertions). `--share`
// makes it reachable over the user's tailnet.
//
// Instances are tracked in .dev/<target>.json: a state file marks a
// DELIBERATE long-lived instance (not a leak). Cloud's WorkOS/Autumn
// emulators run inside the detached runner process this CLI spawns.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { JourneyFile } from "../src/journey/codegen";
import type { Role, Step } from "../src/journey/steps";

const e2eDir = fileURLToPath(new URL("..", import.meta.url));
const devDir = join(e2eDir, ".dev");
const cliPath = fileURLToPath(import.meta.url);

interface InstanceState {
  readonly target: "selfhost" | "cloud";
  status: "starting" | "ready" | "failed";
  error?: string;
  readonly runnerPid: number;
  childPids?: ReadonlyArray<number>;
  /** env other CLI commands must set before importing targets/registry. */
  env?: Record<string, string>;
  urls?: Record<string, string>;
  admin?: { readonly email: string; readonly password: string };
  /** tailscale serve --https ports to turn off on `down`. */
  servePorts?: ReadonlyArray<number>;
  readonly logFile: string;
  readonly startedAt: string;
}

const statePath = (target: string) => join(devDir, `${target}.json`);
const readState = (target: string): InstanceState | undefined => {
  try {
    return JSON.parse(readFileSync(statePath(target), "utf8")) as InstanceState;
  } catch {
    return undefined;
  }
};
const writeState = (state: InstanceState) => {
  mkdirSync(devDir, { recursive: true });
  writeFileSync(statePath(state.target), JSON.stringify(state, null, 1));
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// --- tailnet helpers -------------------------------------------------------

const TAILSCALE_CANDIDATES = [
  "tailscale",
  "/opt/homebrew/opt/tailscale/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];

const sh = (cmd: string, args: ReadonlyArray<string>): Promise<{ ok: boolean; out: string }> =>
  new Promise((resolve) => {
    const child = spawn(cmd, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", () => resolve({ ok: false, out }));
    child.on("exit", (code) => resolve({ ok: code === 0, out }));
  });

const findTailscale = async (): Promise<string | undefined> => {
  for (const candidate of TAILSCALE_CANDIDATES) {
    const { ok } = await sh(candidate, ["version"]);
    if (ok) return candidate;
  }
  return undefined;
};

/** This machine's tailnet IPv4 (100.x.y.z), from interfaces — works even
 * when the tailscale CLI is a broken shim. */
const tailnetIp = (): string | undefined => {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === "IPv4" && addr.address.startsWith("100.")) return addr.address;
    }
  }
  return undefined;
};

const tailnetDnsName = async (ts: string): Promise<string | undefined> => {
  const { ok, out } = await sh(ts, ["status", "--json"]);
  if (!ok) return undefined;
  try {
    const dns = (JSON.parse(out) as { Self?: { DNSName?: string } }).Self?.DNSName;
    return dns?.replace(/\.$/, "");
  } catch {
    return undefined;
  }
};

// --- up --------------------------------------------------------------------

const up = async (target: string, flags: ReadonlySet<string>) => {
  if (target !== "selfhost" && target !== "cloud") {
    throw new Error(`unknown target ${JSON.stringify(target)} — selfhost | cloud`);
  }
  const existing = readState(target);
  if (existing && alive(existing.runnerPid) && existing.status !== "failed") {
    console.log(`${target} already up (runner ${existing.runnerPid}):`);
    printInstance(existing);
    return;
  }
  rmSync(statePath(target), { force: true });

  mkdirSync(devDir, { recursive: true });
  const logFile = join(devDir, `${target}.log`);
  rmSync(logFile, { force: true });
  const runnerArgs = [cliPath, "__run", target, ...flags];
  const runner = spawn("bun", runnerArgs, {
    cwd: e2eDir,
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, E2E_CLI_LOG: logFile },
  });
  runner.unref();
  console.log(`booting ${target} (runner ${runner.pid}, log: ${logFile}) …`);

  const deadline = Date.now() + 240_000;
  for (;;) {
    const state = readState(target);
    if (state?.status === "ready") {
      printInstance(state);
      return;
    }
    if (state?.status === "failed") {
      throw new Error(`${target} boot failed: ${state.error}\n  log: ${logFile}`);
    }
    if (runner.pid !== undefined && !alive(runner.pid)) {
      throw new Error(`runner died during boot — log: ${logFile}`);
    }
    if (Date.now() > deadline) throw new Error(`timed out booting ${target} — log: ${logFile}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
};

const printInstance = (state: InstanceState) => {
  for (const [name, url] of Object.entries(state.urls ?? {})) {
    console.log(`  ${name.padEnd(8)} ${url}`);
  }
  if (state.admin) console.log(`  login    ${state.admin.email} / ${state.admin.password}`);
  console.log(`  log      ${state.logFile}`);
};

// The detached runner: boots the target, owns it (cloud's emulators live in
// this process), writes the state file, and tears down on SIGTERM.
const run = async (target: "selfhost" | "cloud", flags: ReadonlySet<string>) => {
  const share = flags.has("--share");
  const logFile = process.env.E2E_CLI_LOG ?? join(devDir, `${target}.log`);
  const base: Omit<InstanceState, "status"> = {
    target,
    runnerPid: process.pid,
    logFile,
    startedAt: new Date().toISOString(),
  };
  writeState({ ...base, status: "starting" });

  try {
    let state: InstanceState;
    let teardown: () => Promise<void>;

    // Claim ports atomically from this checkout's block (src/ports.ts) — the
    // held block lock doubles as "this instance is deliberate, not a leak",
    // and a concurrently running vitest suite walks to its own block.
    const { claimPorts } = await import("../src/ports");

    if (target === "selfhost") {
      const { bootSelfhost } = await import("../setup/selfhost.boot");
      const claim = await claimPorts([
        { envVar: "E2E_SELFHOST_PORT", offset: 4, label: "selfhost vite dev (cli)" },
      ]);
      const port = claim.ports.E2E_SELFHOST_PORT!;
      const ip = share ? tailnetIp() : undefined;
      const baseUrl = ip ? `http://${ip}:${port}` : `http://localhost:${port}`;
      const admin = { email: "admin@e2e.test", password: "e2e-admin-password-123" };
      const booted = await bootSelfhost({
        port,
        webBaseUrl: baseUrl,
        admin,
        host: share ? "0.0.0.0" : undefined,
        fresh: !flags.has("--keep-data"),
        logFile,
      });
      teardown = async () => {
        await booted.teardown();
        await claim.release();
      };
      state = {
        ...base,
        status: "ready",
        childPids: booted.pids,
        env: {
          E2E_TARGET: "selfhost",
          E2E_SELFHOST_URL: baseUrl,
          E2E_SELFHOST_ADMIN_EMAIL: admin.email,
          E2E_SELFHOST_ADMIN_PASSWORD: admin.password,
        },
        urls: { app: baseUrl },
        admin,
      };
    } else {
      const { bootCloud } = await import("../setup/cloud.boot");
      const claim = await claimPorts([
        { envVar: "E2E_CLOUD_PORT", offset: 0, label: "cloud vite dev (cli)" },
        { envVar: "E2E_CLOUD_DB_PORT", offset: 1, label: "cloud dev-db (cli)" },
        { envVar: "E2E_WORKOS_EMULATOR_PORT", offset: 2, label: "WorkOS emulator (cli)" },
        { envVar: "E2E_AUTUMN_EMULATOR_PORT", offset: 3, label: "Autumn emulator (cli)" },
      ]);
      const cloudPort = claim.ports.E2E_CLOUD_PORT!;
      const dbPort = claim.ports.E2E_CLOUD_DB_PORT!;
      const workosPort = claim.ports.E2E_WORKOS_EMULATOR_PORT!;
      const autumnPort = claim.ports.E2E_AUTUMN_EMULATOR_PORT!;
      const clientId = "client_e2e_emulate";
      const cookiePassword = "e2e_cookie_password_0123456789abcdef0123456789abcdef";

      // Sharing cloud needs HTTPS on BOTH the app and the WorkOS emulator —
      // the app's auth cookies are Secure, and the browser walks the login
      // redirect across both origins (see RUNNING.md).
      let publicUrl = `http://localhost:${cloudPort}`;
      let workosPublicUrl: string | undefined;
      let servePorts: number[] | undefined;
      let host: string | undefined;
      if (share) {
        const ts = await findTailscale();
        const dns = ts ? await tailnetDnsName(ts) : undefined;
        if (!ts || !dns) throw new Error("--share for cloud needs a working tailscale CLI");
        const appHttps = cloudPort + 4000;
        const workosHttps = workosPort + 4000;
        const appServe = await sh(ts, [
          "serve",
          "--bg",
          `--https=${appHttps}`,
          `http://127.0.0.1:${cloudPort}`,
        ]);
        const workosServe = await sh(ts, [
          "serve",
          "--bg",
          `--https=${workosHttps}`,
          `http://127.0.0.1:${workosPort}`,
        ]);
        if (!appServe.ok || !workosServe.ok) {
          throw new Error(`tailscale serve failed:\n${appServe.out}\n${workosServe.out}`);
        }
        publicUrl = `https://${dns}:${appHttps}`;
        workosPublicUrl = `https://${dns}:${workosHttps}`;
        servePorts = [appHttps, workosHttps];
        host = "127.0.0.1"; // proxied — no direct bind needed
      }

      const booted = await bootCloud({
        cloudPort,
        dbPort,
        workosPort,
        autumnPort,
        workosClientId: clientId,
        cookiePassword,
        publicUrl,
        workosPublicUrl,
        host,
        logFile,
      });
      teardown = async () => {
        await booted.teardown();
        await claim.release();
      };
      state = {
        ...base,
        status: "ready",
        childPids: booted.pids,
        env: {
          E2E_TARGET: "cloud",
          E2E_CLOUD_URL: publicUrl,
          E2E_CLOUD_PORT: String(cloudPort),
          E2E_CLOUD_DB_PORT: String(dbPort),
          E2E_WORKOS_EMULATOR_PORT: String(workosPort),
          E2E_AUTUMN_EMULATOR_PORT: String(autumnPort),
        },
        urls: {
          app: publicUrl,
          workos: booted.workosUrl,
          autumn: booted.autumnUrl,
        },
        servePorts,
      };
    }

    writeState(state);

    const shutdown = async () => {
      await teardown();
      if (state.servePorts) {
        const ts = await findTailscale();
        if (ts) {
          for (const port of state.servePorts) await sh(ts, ["serve", `--https=${port}`, "off"]);
        }
      }
      rmSync(statePath(target), { force: true });
      process.exit(0);
    };
    process.on("SIGTERM", () => void shutdown());
    process.on("SIGINT", () => void shutdown());
    // Stay alive: this process owns the instance (and cloud's emulators).
    setInterval(() => {}, 60_000);
  } catch (error) {
    writeState({ ...base, status: "failed", error: String(error) });
    process.exit(1);
  }
};

// --- target-backed commands ------------------------------------------------

/** Point the targets module at the running instance, then import it. */
const loadTarget = async (targetName: string) => {
  const state = readState(targetName);
  if (!state || state.status !== "ready" || !alive(state.runnerPid)) {
    throw new Error(`${targetName} is not up — run: bun scripts/cli.ts up ${targetName}`);
  }
  for (const [key, value] of Object.entries(state.env ?? {})) process.env[key] = value;
  const { resolveTarget } = await import("../targets/registry");
  return { target: resolveTarget(), state };
};

const runEffect = async <A>(effect: unknown): Promise<A> => {
  const { Effect } = await import("effect");
  const { FetchHttpClient } = await import("effect/unstable/http");
  return Effect.runPromise(
    (effect as ReturnType<typeof Effect.succeed<A>>).pipe(Effect.provide(FetchHttpClient.layer)),
  );
};

const identity = async (targetName: string, flags: ReadonlySet<string>) => {
  const { target } = await loadTarget(targetName);
  const minted = await runEffect<import("../src/target").Identity>(
    target.newIdentity(flags.has("--no-org") ? { org: false } : undefined),
  );
  console.log(JSON.stringify(minted, null, 2));
};

const apiCall = async (targetName: string, endpoint: string | undefined, json?: string) => {
  if (!endpoint?.includes(".")) {
    throw new Error("usage: api <target> <group.endpoint> [json] — e.g. api selfhost tools.list");
  }
  const { target } = await loadTarget(targetName);
  const [group, method] = endpoint.split(".", 2) as [string, string];
  // No-arg endpoints (tools.list) reject a spurious {}; only pass what was given.
  const args = json === undefined ? undefined : (JSON.parse(json) as Record<string, unknown>);

  const { Effect } = await import("effect");
  const { FetchHttpClient } = await import("effect/unstable/http");
  const { composePluginApi } = await import("@executor-js/api/server");
  const { openApiHttpPlugin } = await import("@executor-js/plugin-openapi/api");
  const { graphqlHttpPlugin } = await import("@executor-js/plugin-graphql/api");
  const { mcpHttpPlugin } = await import("@executor-js/plugin-mcp/api");
  const { makeApiSurface } = await import("../src/surfaces/api");

  const apiDef = composePluginApi([
    openApiHttpPlugin(),
    graphqlHttpPlugin(),
    mcpHttpPlugin(),
  ] as const);
  const surface = makeApiSurface(target);

  // The endpoint is picked at runtime, so the client is driven untyped here —
  // the full static typing lives in scenarios; this is the interactive probe.
  const program = Effect.gen(function* () {
    const who = yield* target.newIdentity();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client: any = yield* surface.client(apiDef as any, who);
    if (typeof client[group]?.[method] !== "function") {
      const groups = Object.keys(client).filter((k) => typeof client[k] === "object");
      throw new Error(`no endpoint ${endpoint}; groups: ${groups.join(", ")}`);
    }
    return yield* client[group][method](args);
  }) as import("effect").Effect.Effect<
    unknown,
    unknown,
    import("effect/unstable/http").HttpClient.HttpClient
  >;
  const result = await Effect.runPromise(program.pipe(Effect.provide(FetchHttpClient.layer)));
  console.log(JSON.stringify(result, null, 2));
};

const mcpCall = async (
  targetName: string,
  sub: string | undefined,
  rest: ReadonlyArray<string>,
) => {
  const { target } = await loadTarget(targetName);
  const { Effect } = await import("effect");
  const { FetchHttpClient } = await import("effect/unstable/http");
  const { makeMcpSurface } = await import("../src/surfaces/mcp");
  const surface = makeMcpSurface(target);

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const who = yield* target.newIdentity();
      const session = surface.session(who);
      if (sub === "tools") return yield* session.listTools();
      if (sub === "call") {
        const [tool, json] = rest;
        if (!tool) throw new Error("usage: mcp <target> call <tool> [json]");
        return yield* session.call(tool, json ? (JSON.parse(json) as Record<string, unknown>) : {});
      }
      throw new Error("usage: mcp <target> tools | call <tool> [json]");
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );
  console.log(JSON.stringify(result, null, 2));
};

const ledger = async (targetName: string, service = "workos") => {
  const state = readState(targetName);
  const url = state?.urls?.[service];
  if (!url) throw new Error(`no ${service} emulator url recorded for ${targetName}`);
  const { connectEmulator } = await import("@executor-js/emulate");
  const client = await connectEmulator({ baseUrl: url });
  const entries = await client.ledger.list();
  console.log(JSON.stringify(entries, null, 2));
};

// --- browser journeys ------------------------------------------------------
// Drive a live instance's web UI step by step. Each step appends to a journey
// file and REPLAYS the whole flow from a clean browser, so what you build is, at
// every moment, exactly what `promote` emits as a scenario — develop the flow,
// then crystallize it (e2e/AGENTS.md) with no translation gap. The agent can't
// see the screen, so every step returns the page's interactive controls (the
// vocabulary the next step is written against) plus a screenshot for a human.

const journeyPaths = (target: string) => ({
  file: join(devDir, `${target}.journey.json`),
  shotsDir: join(devDir, `${target}.journey`),
});

const readJourney = (target: string): JourneyFile => {
  try {
    return JSON.parse(readFileSync(journeyPaths(target).file, "utf8")) as JourneyFile;
  } catch {
    return { target, org: true, steps: [] };
  }
};

const writeJourney = (journey: JourneyFile) => {
  mkdirSync(devDir, { recursive: true });
  writeFileSync(journeyPaths(journey.target).file, JSON.stringify(journey, null, 1));
};

const STEP_ROLES = new Set<Role>([
  "link",
  "button",
  "heading",
  "textbox",
  "tab",
  "menuitem",
  "checkbox",
]);

/** One CLI step verb → a Step. The verbs are deliberately plain English so the
 * journey reads like instructions: goto / click / click-text / fill / press /
 * see / at-url / run / request. */
const parseStep = (
  verb: string,
  args: ReadonlyArray<string>,
  opts: { readonly label?: string; readonly contains?: string },
): Step => {
  const withLabel = opts.label ? { label: opts.label } : {};
  const withContains = opts.contains !== undefined ? { contains: opts.contains } : {};
  switch (verb) {
    case "goto": {
      const path = args[0];
      if (!path) throw new Error("usage: browse <target> goto <path>   (e.g. goto /)");
      return { kind: "goto", path, ...withLabel };
    }
    case "click": {
      const role = args[0];
      const name = args.slice(1).join(" ");
      if (!role || !name) {
        throw new Error(
          "usage: browse <target> click <role> <name>   (role: " + [...STEP_ROLES].join("|") + ")",
        );
      }
      if (!STEP_ROLES.has(role as Role)) throw new Error(`unknown role ${JSON.stringify(role)}`);
      return { kind: "clickRole", role: role as Role, name, ...withLabel };
    }
    case "click-text": {
      const text = args.join(" ");
      if (!text) throw new Error("usage: browse <target> click-text <text>");
      return { kind: "clickText", text, ...withLabel };
    }
    case "fill": {
      const field = args[0];
      const value = args.slice(1).join(" ");
      if (!field || args.length < 2) throw new Error("usage: browse <target> fill <field> <value>");
      return { kind: "fill", field, value, ...withLabel };
    }
    case "press": {
      const key = args[0];
      if (!key) throw new Error("usage: browse <target> press <key>   (e.g. press Enter)");
      return { kind: "press", key, ...withLabel };
    }
    case "see": {
      const text = args.join(" ");
      if (!text)
        throw new Error("usage: browse <target> see <text>   (asserts the text is visible)");
      return { kind: "expectText", text, ...withLabel };
    }
    case "at-url": {
      const contains = args[0];
      if (!contains) throw new Error("usage: browse <target> at-url <substring>");
      return { kind: "expectUrl", contains, ...withLabel };
    }
    case "run": {
      const command = args.join(" ");
      if (!command) {
        throw new Error(
          'usage: browse <target> run "<command>" [--contains <text>]   ({base} = the instance URL)',
        );
      }
      return { kind: "run", command, ...withContains, ...withLabel };
    }
    case "request": {
      const method = (args[0] ?? "").toUpperCase();
      const path = args[1];
      if (!method || !path) {
        throw new Error("usage: browse <target> request <METHOD> <path> [--contains <text>]");
      }
      return { kind: "request", method, path, ...withContains, ...withLabel };
    }
    default:
      throw new Error(
        `unknown step ${JSON.stringify(verb)} — goto | click | click-text | fill | press | see | at-url | run | request`,
      );
  }
};

const printJourney = (journey: JourneyFile) => {
  if (journey.steps.length === 0) return console.log(`${journey.target}: empty journey`);
  console.log(`${journey.target} journey (${journey.steps.length} steps, org=${journey.org}):`);
  journey.steps.forEach((step, index) => {
    console.log(`  ${String(index + 1).padStart(2)}. ${stepLabelOf(step)}`);
  });
};

// A local copy of the label default so printing doesn't pull in the browser
// module (which imports playwright). Kept trivially in sync with steps.ts.
const stepLabelOf = (step: Step): string => {
  if (step.label) return step.label;
  if (step.kind === "goto") return `goto ${step.path}`;
  if (step.kind === "clickRole") return `click ${step.role} ${JSON.stringify(step.name)}`;
  if (step.kind === "clickText") return `click-text ${JSON.stringify(step.text)}`;
  if (step.kind === "fill") return `fill ${JSON.stringify(step.field)}`;
  if (step.kind === "press") return `press ${step.key}`;
  if (step.kind === "expectText") return `see ${JSON.stringify(step.text)}`;
  if (step.kind === "expectUrl") return `at-url ${JSON.stringify(step.contains)}`;
  if (step.kind === "run") {
    return `run ${JSON.stringify(step.command)}${step.contains ? ` → ${JSON.stringify(step.contains)}` : ""}`;
  }
  return `request ${step.method} ${step.path}${step.contains ? ` → ${JSON.stringify(step.contains)}` : ""}`;
};

const browse = async (raw: ReadonlyArray<string>) => {
  const target = raw[0];
  if (!target) throw new Error("usage: browse <target> <step…>  (or show | undo | reset)");

  // Re-parse tokens here: --label takes a value, which the top-level flag/arg
  // split would mangle.
  let label: string | undefined;
  let contains: string | undefined;
  const positional: string[] = [];
  const bools = new Set<string>();
  const tokens = raw.slice(1);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === "--label") {
      label = tokens[++i];
      continue;
    }
    if (token.startsWith("--label=")) {
      label = token.slice("--label=".length);
      continue;
    }
    if (token === "--contains") {
      contains = tokens[++i];
      continue;
    }
    if (token.startsWith("--contains=")) {
      contains = token.slice("--contains=".length);
      continue;
    }
    if (token.startsWith("--")) {
      bools.add(token);
      continue;
    }
    positional.push(token);
  }

  const verb = positional[0];
  const { file, shotsDir } = journeyPaths(target);
  let journey = readJourney(target);

  if (verb === "show") return printJourney(journey);
  if (verb === "reset") {
    rmSync(file, { force: true });
    rmSync(shotsDir, { recursive: true, force: true });
    return console.log(`${target}: journey reset`);
  }
  if (!verb) throw new Error("usage: browse <target> <step…>  (or show | undo | reset)");

  // The flow runs as ONE minted identity per replay — same as the generated
  // test mints one per run, so a stateful journey behaves identically.
  const { target: resolved } = await loadTarget(target);
  const identity = await runEffect<import("../src/target").Identity>(
    resolved.newIdentity(journey.org ? undefined : { org: false }),
  );
  const { replayJourney } = await import("../src/journey/run");

  let steps = [...journey.steps];
  if (verb === "undo") {
    if (steps.length === 0) throw new Error("nothing to undo");
    steps = steps.slice(0, -1);
  } else {
    if (steps.length === 0 && bools.has("--no-org")) journey = { ...journey, org: false };
    steps = [...steps, parseStep(verb, positional.slice(1), { label, contains })];
  }

  mkdirSync(shotsDir, { recursive: true });
  const shot = join(shotsDir, `${String(steps.length).padStart(2, "0")}.png`);
  const observation = await replayJourney(resolved, identity, steps, { screenshotPath: shot });

  if (observation.failedStep) {
    const failed = observation.failedStep;
    const isNew = verb !== "undo" && failed.index === steps.length - 1;
    console.log(
      `✗ ${isNew ? "this step" : `step ${failed.index + 1} (${stepLabelOf(steps[failed.index]!)})`} failed — journey unchanged.`,
    );
    console.log(`  ${failed.error.split("\n")[0]}`);
    console.log(`  screenshot: ${observation.screenshotPath}`);
    return;
  }

  journey = { ...journey, steps };
  writeJourney(journey);

  console.log(`→ ${observation.url}  ${JSON.stringify(observation.title)}`);
  console.log(`  screenshot: ${observation.screenshotPath}`);
  if (observation.lastOutput) {
    const lines = observation.lastOutput.split("\n").slice(0, 12);
    console.log("output:");
    for (const line of lines) console.log(`  ${line}`);
  }
  printJourney(journey);
  if (observation.controls.length > 0) {
    console.log("controls on the page (role · name):");
    for (const control of observation.controls.slice(0, 40)) {
      console.log(`  ${control.role.padEnd(9)} ${control.name}`);
    }
    if (observation.controls.length > 40) {
      console.log(`  … ${observation.controls.length - 40} more`);
    }
  }
};

const promote = async (raw: ReadonlyArray<string>) => {
  const target = raw[0];
  const positional = raw.slice(1).filter((arg) => !arg.startsWith("--"));
  const name = positional[0];
  const noRun = raw.includes("--no-run");
  if (!target || !name) {
    throw new Error('usage: promote <target> "<scenario name>" [--no-run]');
  }
  const journey = readJourney(target);
  if (journey.steps.length === 0) {
    throw new Error(`no journey for ${target} — build one with \`browse ${target} …\` first`);
  }
  const { codegenScenario, journeyHasAssertion, journeyHasBrowserStep } =
    await import("../src/journey/codegen");
  if (!journeyHasBrowserStep(journey)) {
    throw new Error(
      "this journey is all terminal/HTTP steps — `promote` generates browser-anchored scenarios. Add a browser step, or write a CLI/API test directly.",
    );
  }
  if (!journeyHasAssertion(journey)) {
    throw new Error(
      "this journey has no assertion (a `see`, `at-url`, `request`, or `run --contains` step), so the scenario would prove nothing. Add one, then promote.",
    );
  }

  const source = codegenScenario(name, journey);
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  // Scope the file to the target's own dir (cloud/, selfhost/) so it runs only
  // where its UI selectors apply, not on every cross-target host.
  const relFile = join(target, `${slug}.gen.test.ts`);
  writeFileSync(join(e2eDir, relFile), source);
  console.log(`wrote ${relFile}  (${journey.steps.length} steps from the ${target} journey)`);

  const urlKey = `E2E_${target.toUpperCase()}_URL`;
  const url = readState(target)?.env?.[urlKey];
  if (noRun || !url) {
    console.log(
      `run it against the live instance:\n  ${urlKey}=<url> bunx vitest run --project ${target} ${relFile}`,
    );
    return;
  }

  console.log(`running it against the live instance (${url}) …`);
  const proc = spawn("bunx", ["vitest", "run", "--project", target, relFile], {
    cwd: e2eDir,
    stdio: "inherit",
    env: { ...process.env, [urlKey]: url },
  });
  const code: number = await new Promise((resolve) => proc.on("exit", (c) => resolve(c ?? 1)));
  const slugDir = join("runs", target, slug);
  console.log(
    code === 0
      ? `\n✓ passed. Artifacts (test.ts, result.json, session.mp4/film.mp4): e2e/${slugDir}\n  view: cd e2e && bun run serve  →  #/${target}/${slug}`
      : `\n✗ the generated test failed (exit ${code}). The flow that passed live did not pass as a committed test — inspect ${relFile} and e2e/${slugDir}.`,
  );
};

// --- lifecycle commands ----------------------------------------------------

const status = () => {
  if (!existsSync(devDir)) return console.log("no instances");
  const states = readdirSync(devDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(devDir, f), "utf8")) as InstanceState);
  if (states.length === 0) return console.log("no instances");
  for (const state of states) {
    const live = alive(state.runnerPid);
    console.log(
      `${state.target}: ${live ? state.status : "DEAD (stale state file)"} — runner ${state.runnerPid}, since ${state.startedAt}`,
    );
    if (live && state.status === "ready") printInstance(state);
  }
};

const down = async (targetName: string) => {
  const state = readState(targetName);
  if (!state) return console.log(`${targetName}: nothing recorded`);
  if (alive(state.runnerPid)) {
    process.kill(state.runnerPid, "SIGTERM");
    const deadline = Date.now() + 10_000;
    while (alive(state.runnerPid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  // Runner gone (or was already): make sure the children are too.
  for (const pid of state.childPids ?? []) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
  if (state.servePorts) {
    const ts = await findTailscale();
    if (ts) for (const port of state.servePorts) await sh(ts, ["serve", `--https=${port}`, "off"]);
  }
  rmSync(statePath(targetName), { force: true });
  console.log(`${targetName}: down`);
};

const logs = (targetName: string) => {
  const state = readState(targetName);
  if (!state) throw new Error(`${targetName}: not up`);
  console.log(readFileSync(state.logFile, "utf8"));
};

// --- main ------------------------------------------------------------------

const HELP = `e2e dev CLI — the scenario primitives, interactive (see e2e/AGENTS.md)

  up <target> [--share]      boot selfhost|cloud; stays up until \`down\`.
                             --share = reachable over the tailnet
                             (cloud --share fronts app+WorkOS with tailscale HTTPS)
  status                     list running instances
  identity <target> [--no-org]  mint a fresh identity (headers/cookies/creds)
  api <target> <group.endpoint> [json]   typed API call as a fresh identity
  mcp <target> tools | call <tool> [json]   MCP session call
  ledger <target> [workos|autumn]   the emulator's request ledger (cloud)
  browse <target> <step>     drive the live web UI, one step at a time; each step
                             replays the whole flow and prints the page's controls
                             steps: goto <path> | click <role> <name> | click-text <text>
                                    | fill <field> <value> | press <key>
                                    | see <text> | at-url <substring>
                                    | run "<cmd>" | request <METHOD> <path>
                             flags: --label "…", --no-org, --contains <text>
                             ({base} in a run command = the instance URL)
                             browse <target> show | undo | reset
  promote <target> "<name>"  turn the recorded journey into a committed scenario
                             (<target>/<slug>.gen.test.ts) and run it  (--no-run)
  logs <target>              dump the instance's dev-server log
  down <target>              tear down (kills servers, removes tailscale serves)

A browser journey IS the scenario: develop the flow with \`browse\`, then
\`promote\` it. The generated test drives the same surface, so a reviewer judges
it by reading the test and watching its video.

Instances live in e2e/.dev/<target>.json — a state file marks a DELIBERATE
long-lived instance. Use the booted instance for e2e too:
  E2E_SELFHOST_URL=<app url> vitest run --project selfhost <file>`;

const main = async () => {
  const [, , command, ...rest] = process.argv;
  const flags = new Set(rest.filter((a) => a.startsWith("--")));
  const args = rest.filter((a) => !a.startsWith("--"));
  switch (command) {
    case "up":
      return up(args[0] ?? "selfhost", flags);
    case "__run":
      return run(args[0] as "selfhost" | "cloud", flags);
    case "status":
      return status();
    case "identity":
      return identity(args[0] ?? "", flags);
    case "api":
      return apiCall(args[0] ?? "", args[1], args[2]);
    case "mcp":
      return mcpCall(args[0] ?? "", args[1], args.slice(2));
    case "ledger":
      return ledger(args[0] ?? "", args[1]);
    case "browse":
      return browse(rest);
    case "promote":
      return promote(rest);
    case "logs":
      return logs(args[0] ?? "");
    case "down":
      return down(args[0] ?? "");
    default:
      console.log(HELP);
      if (command !== undefined && command !== "help" && command !== "--help") process.exit(1);
  }
};

main().then(
  () => {
    // mcporter sessions / emulator handles keep the loop alive — every
    // command except the detached `__run` runner must exit explicitly.
    if (process.argv[2] !== "__run") process.exit(0);
  },
  (error: unknown) => {
    console.error(String(error instanceof Error ? error.message : error));
    process.exit(1);
  },
);
