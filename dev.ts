/**
 * Dev runner — starts all services concurrently with colored output.
 *
 * Usage: bun dev
 *
 * Starts:
 *   1. Convex local backend
 *   2. Executor server (port 4001)
 *   3. Assistant server (port 3000)
 *   4. Discord bot
 *
 * All processes are killed when this script exits (Ctrl+C).
 */

const colors = {
  convex: "\x1b[36m",   // cyan
  executor: "\x1b[33m", // yellow
  assistant: "\x1b[32m", // green
  bot: "\x1b[35m",      // magenta
  reset: "\x1b[0m",
};

interface Service {
  name: keyof typeof colors;
  cmd: string[];
  cwd: string;
  delay?: number;
  env?: Record<string, string>;
}

const services: Service[] = [
  {
    name: "convex",
    cmd: ["bunx", "convex", "dev", "--local"],
    cwd: "./executor",
  },
  {
    name: "executor",
    cmd: ["bun", "--hot", "apps/server/src/index.ts"],
    cwd: "./executor",
    delay: 2000, // wait for convex to start
    env: { EXECUTOR_SERVER_AUTO_EXECUTE: "1" },
  },
  {
    name: "assistant",
    cmd: ["bun", "run", "--cwd", "packages/server", "dev"],
    cwd: "./assistant",
    delay: 4000, // wait for executor to start
  },
  ...(Bun.env.DISCORD_BOT_TOKEN ? [{
    name: "bot" as const,
    cmd: ["bun", "run", "--cwd", "packages/bot", "dev"],
    cwd: "./assistant",
    delay: 5000, // wait for assistant server
  }] : []),
];

const procs: Bun.Subprocess[] = [];

function prefix(name: keyof typeof colors, line: string): string {
  const color = colors[name] ?? "";
  return `${color}[${name}]${colors.reset} ${line}`;
}

async function startService(service: Service) {
  if (service.delay) {
    await Bun.sleep(service.delay);
  }

  console.log(prefix(service.name, `Starting: ${service.cmd.join(" ")}`));

  const proc = Bun.spawn(service.cmd, {
    cwd: service.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...Bun.env,
      FORCE_COLOR: "1",
      ...service.env,
    },
  });

  procs.push(proc);

  // Stream stdout
  const streamOutput = async (stream: ReadableStream<Uint8Array>, isStderr: boolean) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.trim()) {
          const out = isStderr ? process.stderr : process.stdout;
          out.write(prefix(service.name, line) + "\n");
        }
      }
    }

    if (buffer.trim()) {
      const out = isStderr ? process.stderr : process.stdout;
      out.write(prefix(service.name, buffer) + "\n");
    }
  };

  streamOutput(proc.stdout, false);
  streamOutput(proc.stderr, true);

  proc.exited.then((code) => {
    console.log(prefix(service.name, `Exited with code ${code}`));
  });
}

// Cleanup on exit
process.on("SIGINT", () => {
  console.log("\nShutting down all services...");
  for (const proc of procs) {
    proc.kill();
  }
  process.exit(0);
});

process.on("SIGTERM", () => {
  for (const proc of procs) {
    proc.kill();
  }
  process.exit(0);
});

// Start all services
console.log("Starting all services...\n");
if (!Bun.env.DISCORD_BOT_TOKEN) {
  console.log(`${colors.bot}[bot]${colors.reset} Skipped — no DISCORD_BOT_TOKEN set\n`);
}
await Promise.all(services.map(startService));

// Keep alive
await new Promise(() => {});
