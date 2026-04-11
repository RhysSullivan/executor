import { Command, Options } from "@effect/cli";
import { Effect, Option } from "effect";

import type { SupervisorError } from "./errors.js";
import { PlatformSupervisor } from "./platform-supervisor.js";
import { DEFAULT_SERVICE_PORT, type ServiceSpec } from "./service-spec.js";

const labelOpt = Options.text("label").pipe(
  Options.optional,
  Options.withDescription("Service label (launchd label, systemd unit name, etc.)"),
);
const unitFileOpt = Options.text("unit-file").pipe(
  Options.optional,
  Options.withDescription("Platform unit file path override (plist on macOS, .service on Linux)"),
);
const logFileOpt = Options.text("log-file").pipe(
  Options.optional,
  Options.withDescription("Log file path override"),
);
const portOpt = Options.integer("port").pipe(
  Options.withDefault(DEFAULT_SERVICE_PORT),
  Options.withDescription("Port the daemon should bind to"),
);
const scopeOpt = Options.text("scope").pipe(
  Options.optional,
  Options.withDescription("Scope directory"),
);
const jsonOpt = Options.boolean("json").pipe(
  Options.withDefault(false),
  Options.withDescription("Output as JSON"),
);

const unwrap = <T>(opt: Option.Option<T>): T | undefined => Option.getOrUndefined(opt);

const buildSpec = (input: {
  readonly label: Option.Option<string>;
  readonly unitFile: Option.Option<string>;
  readonly logFile?: Option.Option<string>;
  readonly port?: number;
  readonly scope?: Option.Option<string>;
}): ServiceSpec => ({
  label: unwrap(input.label),
  unitFilePath: unwrap(input.unitFile),
  logPath: input.logFile ? unwrap(input.logFile) : undefined,
  port: input.port,
  scope: input.scope ? unwrap(input.scope) : undefined,
});

/**
 * Normalized error renderer. Every {@link PlatformSupervisor} method returns
 * a {@link SupervisorError} — this helper converts the 4-variant tagged union
 * into stderr output + a non-zero exit code so the CLI behaves consistently
 * across backends.
 */
const handleErrors = <A>(effect: Effect.Effect<A, SupervisorError, PlatformSupervisor>) =>
  effect.pipe(
    Effect.catchTags({
      UnsupportedPlatform: (err) =>
        Effect.sync(() => {
          console.error(
            err.message ?? `Service management is not supported on platform "${err.platform}".`,
          );
          process.exit(1);
        }),
      BootstrapFailed: (err) =>
        Effect.sync(() => {
          console.error(`Service bootstrap failed for ${err.label}:`);
          console.error(err.stderr || err.stdout || `exit code ${err.code}`);
          process.exit(1);
        }),
      TeardownFailed: (err) =>
        Effect.sync(() => {
          console.error(`Service teardown failed for ${err.label}:`);
          console.error(err.stderr || err.stdout || `exit code ${err.code}`);
          process.exit(1);
        }),
      ServiceReadinessTimeout: (err) =>
        Effect.sync(() => {
          console.error(
            `Service "${err.label}" failed to become reachable at ${err.url} within ${err.elapsedMs}ms; rolled back.`,
          );
          process.exit(1);
        }),
    }),
  );

const installCommand = Command.make(
  "install",
  {
    label: labelOpt,
    unitFile: unitFileOpt,
    logFile: logFileOpt,
    port: portOpt,
    scope: scopeOpt,
  },
  ({ label, unitFile, logFile, port, scope }) =>
    handleErrors(
      Effect.gen(function* () {
        const supervisor = yield* PlatformSupervisor;
        const result = yield* supervisor.install(
          buildSpec({ label, unitFile, logFile, port, scope }),
        );
        console.log(`Installed service: ${result.label}`);
        console.log(`Unit file: ${result.unitFilePath}`);
        console.log(`Logs:      ${result.logPath}`);
        console.log(`URL:       ${result.url}`);
      }),
    ),
).pipe(Command.withDescription("Install the executor daemon as a system service"));

const uninstallCommand = Command.make(
  "uninstall",
  { label: labelOpt, unitFile: unitFileOpt },
  ({ label, unitFile }) =>
    handleErrors(
      Effect.gen(function* () {
        const supervisor = yield* PlatformSupervisor;
        yield* supervisor.uninstall(buildSpec({ label, unitFile }));
        console.log("Uninstalled executor service.");
      }),
    ),
).pipe(Command.withDescription("Uninstall the executor daemon service"));

const startCommand = Command.make(
  "start",
  { label: labelOpt, unitFile: unitFileOpt, port: portOpt },
  ({ label, unitFile, port }) =>
    handleErrors(
      Effect.gen(function* () {
        const supervisor = yield* PlatformSupervisor;
        yield* supervisor.start(buildSpec({ label, unitFile, port }));
        console.log("Started executor service.");
      }),
    ),
).pipe(Command.withDescription("(Re)load the executor service"));

const stopCommand = Command.make(
  "stop",
  { label: labelOpt, unitFile: unitFileOpt },
  ({ label, unitFile }) =>
    handleErrors(
      Effect.gen(function* () {
        const supervisor = yield* PlatformSupervisor;
        yield* supervisor.stop(buildSpec({ label, unitFile }));
        console.log("Stopped executor service.");
      }),
    ),
).pipe(Command.withDescription("Stop the executor service"));

const statusCommand = Command.make(
  "status",
  {
    label: labelOpt,
    unitFile: unitFileOpt,
    logFile: logFileOpt,
    port: portOpt,
    json: jsonOpt,
  },
  ({ label, unitFile, logFile, port, json }) =>
    handleErrors(
      Effect.gen(function* () {
        const supervisor = yield* PlatformSupervisor;
        const status = yield* supervisor.status(buildSpec({ label, unitFile, logFile, port }));
        if (json) {
          console.log(JSON.stringify(status, null, 2));
          return;
        }
        console.log(`Label:     ${status.label}`);
        console.log(`Unit file: ${status.unitFilePath}`);
        console.log(`Logs:      ${status.logPath}`);
        console.log(`URL:       ${status.url}`);
        console.log(`Installed: ${status.installed ? "yes" : "no"}`);
        console.log(
          `Running:   ${status.running ? "yes" : "no"}${status.pid ? ` (pid ${status.pid})` : ""}`,
        );
        console.log(`Reachable: ${status.reachable ? "yes" : "no"}`);
      }),
    ),
).pipe(Command.withDescription("Show executor service status"));

/**
 * Root `service` command group. The returned Command reads
 * {@link PlatformSupervisor} from Effect Context — callers must provide a
 * concrete backend layer (e.g. `makeLaunchdSupervisorLayer()`) via
 * `Effect.provide` on the surrounding program.
 */
export const makeServiceCommand = () =>
  Command.make("service").pipe(
    Command.withSubcommands([
      installCommand,
      uninstallCommand,
      startCommand,
      stopCommand,
      statusCommand,
    ] as const),
    Command.withDescription("Manage the executor daemon as a system service"),
  );
