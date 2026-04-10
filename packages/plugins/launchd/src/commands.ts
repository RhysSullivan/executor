import { Command, Options } from "@effect/cli";
import { Effect, Option } from "effect";

import {
  installAgent,
  printAgent,
  startAgent,
  stopAgent,
  uninstallAgent,
  type AgentStatus,
  type InstallResult,
  type LaunchdError,
} from "./supervisor.js";

const labelOpt = Options.text("label").pipe(
  Options.optional,
  Options.withDescription("LaunchAgent label"),
);
const plistOpt = Options.text("plist").pipe(
  Options.optional,
  Options.withDescription("Plist path override"),
);
const logFileOpt = Options.text("log-file").pipe(
  Options.optional,
  Options.withDescription("Log file path override"),
);
const portOpt = Options.integer("port").pipe(
  Options.withDefault(4788),
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

const handleErrors = <A>(effect: Effect.Effect<A, LaunchdError>): Effect.Effect<A, never> =>
  effect.pipe(
    Effect.catchTags({
      LaunchdUnsupportedPlatform: (err) =>
        Effect.sync(() => {
          console.error(`Error: ${err.message}`);
          process.exit(1);
        }),
      LaunchdBootstrapFailed: (err) =>
        Effect.sync(() => {
          console.error(`launchctl bootstrap failed for ${err.label}:`);
          console.error(err.stderr || err.stdout || `exit code ${err.code}`);
          process.exit(1);
        }),
      LaunchdReadinessTimeout: (err) =>
        Effect.sync(() => {
          console.error(
            `Daemon failed to become reachable at ${err.url} within ${err.elapsedMs}ms; rolled back.`,
          );
          process.exit(1);
        }),
      LaunchdBootoutFailed: (err) =>
        Effect.sync(() => {
          console.error(`launchctl bootout failed for ${err.label}:`);
          console.error(err.stderr || err.stdout || `exit code ${err.code}`);
          process.exit(1);
        }),
    }),
  );

const installCommand = Command.make(
  "install",
  {
    label: labelOpt,
    plist: plistOpt,
    "log-file": logFileOpt,
    port: portOpt,
    scope: scopeOpt,
  },
  ({ label, plist, "log-file": logFile, port, scope }) =>
    handleErrors(
      installAgent({
        label: unwrap(label),
        plistPath: unwrap(plist),
        logPath: unwrap(logFile),
        port,
        scope: unwrap(scope),
      }).pipe(
        Effect.tap((result: InstallResult) =>
          Effect.sync(() => {
            console.log(`Installed LaunchAgent: ${result.label}`);
            console.log(`Plist: ${result.plistPath}`);
            console.log(`Logs:  ${result.logPath}`);
            console.log(`URL:   ${result.url}`);
          }),
        ),
      ),
    ),
).pipe(Command.withDescription("Install executor daemon as a macOS LaunchAgent"));

const uninstallCommand = Command.make(
  "uninstall",
  { label: labelOpt, plist: plistOpt },
  ({ label, plist }) =>
    handleErrors(
      uninstallAgent({
        label: unwrap(label),
        plistPath: unwrap(plist),
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            console.log("Uninstalled executor LaunchAgent.");
          }),
        ),
      ),
    ),
).pipe(Command.withDescription("Uninstall the executor LaunchAgent"));

const startCommand = Command.make(
  "start",
  { label: labelOpt, plist: plistOpt, port: portOpt },
  ({ label, plist, port }) =>
    handleErrors(
      startAgent({
        label: unwrap(label),
        plistPath: unwrap(plist),
        port,
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            console.log("Started executor LaunchAgent.");
          }),
        ),
      ),
    ),
).pipe(Command.withDescription("(Re)load the executor LaunchAgent"));

const stopCommand = Command.make("stop", { label: labelOpt, plist: plistOpt }, ({ label, plist }) =>
  handleErrors(
    stopAgent({
      label: unwrap(label),
      plistPath: unwrap(plist),
    }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          console.log("Stopped executor LaunchAgent.");
        }),
      ),
    ),
  ),
).pipe(Command.withDescription("Unload the executor LaunchAgent"));

const statusCommand = Command.make(
  "status",
  { label: labelOpt, plist: plistOpt, json: jsonOpt },
  ({ label, plist, json }) =>
    printAgent({
      label: unwrap(label),
      plistPath: unwrap(plist),
    }).pipe(
      Effect.tap((status: AgentStatus) =>
        Effect.sync(() => {
          if (json) {
            console.log(JSON.stringify(status, null, 2));
            return;
          }
          console.log(`Label:     ${status.label}`);
          console.log(`Plist:     ${status.plistPath}`);
          console.log(`Logs:      ${status.logPath}`);
          console.log(`URL:       ${status.url}`);
          console.log(`Installed: ${status.installed ? "yes" : "no"}`);
          console.log(
            `Running:   ${status.running ? "yes" : "no"}${
              status.pid ? ` (pid ${status.pid})` : ""
            }`,
          );
          console.log(`Reachable: ${status.reachable ? "yes" : "no"}`);
        }),
      ),
      Effect.catchTag("LaunchdUnsupportedPlatform", (err) =>
        Effect.sync(() => {
          console.error(`Error: ${err.message}`);
          process.exit(1);
        }),
      ),
    ),
).pipe(Command.withDescription("Show executor LaunchAgent status"));

export const makeServiceCommand = () =>
  Command.make("service").pipe(
    Command.withSubcommands([
      installCommand,
      uninstallCommand,
      startCommand,
      stopCommand,
      statusCommand,
    ] as const),
    Command.withDescription("Manage the executor daemon as a macOS service"),
  );
