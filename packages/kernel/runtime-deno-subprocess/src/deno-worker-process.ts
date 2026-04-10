import { spawn } from "node:child_process";

export type DenoPermissions = {
  /** Allow network access. Pass `true` for all, or an array of allowed hosts. */
  allowNet?: boolean | string[];
  /** Allow file read access. Pass `true` for all, or an array of allowed paths. */
  allowRead?: boolean | string[];
  /** Allow file write access. Pass `true` for all, or an array of allowed paths. */
  allowWrite?: boolean | string[];
  /** Allow environment variable access. Pass `true` for all, or an array of allowed vars. */
  allowEnv?: boolean | string[];
  /** Allow running subprocesses. Pass `true` for all, or an array of allowed commands. */
  allowRun?: boolean | string[];
  /** Allow FFI (foreign function interface). */
  allowFfi?: boolean | string[];
};

export type SpawnDenoWorkerProcessInput = {
  executable: string;
  scriptPath: string;
  permissions?: DenoPermissions;
};

export type DenoWorkerProcessCallbacks = {
  onStdoutLine: (line: string) => void;
  onStderr: (chunk: string) => void;
  onError: (error: Error) => void;
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
};

export type DenoWorkerProcess = {
  stdin: NodeJS.WritableStream;
  dispose: () => void;
};

const normalizeError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

const buildPermissionArgs = (permissions?: DenoPermissions): string[] => {
  if (!permissions) {
    return ["--deny-net", "--deny-read", "--deny-write", "--deny-env", "--deny-run", "--deny-ffi"];
  }

  const args: string[] = [];

  const addPermission = (flag: string, value: boolean | string[] | undefined) => {
    if (value === true) {
      args.push(`--allow-${flag}`);
    } else if (Array.isArray(value) && value.length > 0) {
      args.push(`--allow-${flag}=${value.join(",")}`);
    } else {
      args.push(`--deny-${flag}`);
    }
  };

  addPermission("net", permissions.allowNet);
  addPermission("read", permissions.allowRead);
  addPermission("write", permissions.allowWrite);
  addPermission("env", permissions.allowEnv);
  addPermission("run", permissions.allowRun);
  addPermission("ffi", permissions.allowFfi);

  return args;
};

export const spawnDenoWorkerProcess = (
  input: SpawnDenoWorkerProcessInput,
  callbacks: DenoWorkerProcessCallbacks,
): DenoWorkerProcess => {
  const permissionArgs = buildPermissionArgs(input.permissions);

  const child = spawn(
    input.executable,
    ["run", "--quiet", "--no-prompt", "--no-check", ...permissionArgs, input.scriptPath],
    {
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error("Failed to create piped stdio for Deno worker subprocess");
  }

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let stdoutBuffer = "";

  const onStdoutData = (chunk: string) => {
    stdoutBuffer += chunk;

    while (true) {
      const newlineIndex = stdoutBuffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }

      const line = stdoutBuffer.slice(0, newlineIndex);
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      callbacks.onStdoutLine(line);
    }
  };

  const onStderrData = (chunk: string) => {
    callbacks.onStderr(chunk);
  };

  const onError = (cause: unknown) => {
    callbacks.onError(normalizeError(cause));
  };

  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    callbacks.onExit(code, signal);
  };

  child.stdout.on("data", onStdoutData);
  child.stderr.on("data", onStderrData);
  child.on("error", onError);
  child.on("exit", onExit);

  let disposed = false;

  const dispose = () => {
    if (disposed) {
      return;
    }

    disposed = true;
    child.stdout!.removeListener("data", onStdoutData);
    child.stderr!.removeListener("data", onStderrData);
    child.removeListener("error", onError);
    child.removeListener("exit", onExit);

    if (!child.killed) {
      child.kill("SIGKILL");
    }
  };

  return {
    stdin: child.stdin,
    dispose,
  };
};
