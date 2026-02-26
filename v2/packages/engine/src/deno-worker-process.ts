import { spawn } from "node:child_process";

export type SpawnDenoWorkerProcessInput = {
  executable: string;
  scriptPath: string;
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

export const spawnDenoWorkerProcess = (
  input: SpawnDenoWorkerProcessInput,
  callbacks: DenoWorkerProcessCallbacks,
): DenoWorkerProcess => {
  const child = spawn(
    input.executable,
    [
      "run",
      "--quiet",
      "--no-prompt",
      "--no-check",
      input.scriptPath,
    ],
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
    child.stdout.removeListener("data", onStdoutData);
    child.stderr.removeListener("data", onStderrData);
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
